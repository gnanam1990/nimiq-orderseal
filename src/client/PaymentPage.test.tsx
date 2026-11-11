// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NimiqProviderError } from '@nimiq/mini-app-sdk';
import { PaymentPage } from './PaymentPage';

const wallet = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@nimiq/mini-app-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimiq/mini-app-sdk')>();
  return {
    ...actual,
    getHostNetwork: () => 'mainnet',
    init: async () => ({ sendBasicTransactionWithData: wallet.send }),
  };
});

const order = {
  id: '52a12a96-2a8c-49eb-9771-6504c3b76404',
  code: 'ORDER12345',
  publicToken: 't'.repeat(32),
  state: 'OFFERED',
  itemName: 'Protected bundle',
  amountLuna: 100_000,
  recipient: 'NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCK',
  expiresAt: '2030-01-01T00:00:00.000Z',
  createdAt: '2029-01-01T00:00:00.000Z',
  updatedAt: '2029-01-01T00:00:00.000Z',
  paymentTxHash: null,
  paymentConfirmations: null,
  conflictReasons: [],
  refundExecution: 'OBSERVATION_ONLY',
  terms: {
    id: '52a12a96-2a8c-49eb-9771-6504c3b76404',
    code: 'ORDER12345',
    revision: 1,
    itemName: 'Protected bundle',
    description: 'A real wallet uncertainty test',
    recipient: 'NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCK',
    amountLuna: 100_000,
    asset: 'NIM',
    network: 'mainnet',
    expiresAt: '2030-01-01T00:00:00.000Z',
    fulfilmentReference: 'BUNDLE-1',
    fulfilmentDigest: 'f'.repeat(64),
    termsRevision: 1,
    memo: 'OS1:ORDER12345:1:0123456789ab',
  },
  signature: 'a'.repeat(64),
  observer: {
    source: 'rpc.nimiqwatch.com',
    lastCheckedAt: null,
    requiredConfirmations: 10,
    freshness: 'not_checked',
  },
  fulfilment: null,
  refund: { execution: 'UNSUPPORTED', mode: 'OBSERVATION_ONLY', finalizedLuna: 0 },
};
let fetchedOrder = order;

beforeEach(() => {
  sessionStorage.clear();
  fetchedOrder = order;
  wallet.send.mockReset();
  wallet.send.mockRejectedValue(new NimiqProviderError(
    'TRANSACTION_OUTCOME_UNKNOWN',
    'The wallet lost the submission result.',
  ));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/api/meta')
      ? {
          name: 'OrderSeal',
          asset: 'NIM',
          network: 'mainnet',
          miniAppSdk: '0.2.5',
          requiredConfirmations: 10,
          refundExecution: 'UNSUPPORTED',
          refundMode: 'OBSERVATION_ONLY',
          nimiqPayDeepLinkPrefix: 'nimiqpay://miniapp?url=',
        }
      : fetchedOrder;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('wallet outcome uncertainty fence', () => {
  it('persists and observes the staged hash returned with an unknown wallet outcome', async () => {
    const stagedHash = 'c'.repeat(64);
    wallet.send.mockRejectedValueOnce(new NimiqProviderError(
      'TRANSACTION_OUTCOME_UNKNOWN',
      'The wallet lost the final submission result.',
      undefined,
      { hash: stagedHash },
    ));

    render(<PaymentPage token={order.publicToken} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review and pay in Nimiq Pay' }));

    expect(await screen.findByText('Staged transaction is being observed')).toBeInTheDocument();
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ txHash: stagedHash, hostNetwork: 'mainnet' });
    });
    expect(JSON.parse(sessionStorage.getItem(`orderseal:payment:${order.publicToken}`) ?? '{}'))
      .toMatchObject({ txHash: stagedHash, source: 'wallet-staged-hash' });
    expect(screen.getByRole('button', { name: 'Payment observation pending' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'I checked wallet history — allow retry' })).not.toBeInTheDocument();
    expect(wallet.send).toHaveBeenCalledTimes(1);
  });

  it('cannot call the provider again until wallet history is explicitly acknowledged', async () => {
    render(<PaymentPage token={order.publicToken} />);
    const pay = await screen.findByRole('button', { name: 'Review and pay in Nimiq Pay' });
    fireEvent.click(pay);
    await screen.findByText('PAYMENT_SUBMISSION_UNKNOWN');
    expect(wallet.send).toHaveBeenCalledTimes(1);

    const fenced = screen.getByRole('button', { name: 'Payment observation pending' });
    expect(fenced).toBeDisabled();
    fireEvent.click(fenced);
    expect(wallet.send).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'I checked wallet history — allow retry' }));
    const retry = screen.getByRole('button', { name: 'Review and pay in Nimiq Pay' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(wallet.send).toHaveBeenCalledTimes(2));
  });

  it('keeps a saved pre-expiry attempt visible and fenced after the order expires', async () => {
    fetchedOrder = { ...order, state: 'EXPIRED', expiresAt: '2020-01-01T00:00:00.000Z' };
    sessionStorage.setItem(`orderseal:payment:${order.publicToken}`, JSON.stringify({
      txHash: 'b'.repeat(64),
      idempotencyKey: 'saved-pre-expiry-attempt',
    }));
    render(<PaymentPage token={order.publicToken} />);
    expect(await screen.findByText('Transaction observation is pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment observation pending' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Order expired' })).not.toBeInTheDocument();
  });
});
