/// <reference types="vite/client" />

interface Window {
  nimiqPay?: {
    language?: string;
    network?: 'mainnet' | 'testnet';
    requestFullscreen?: () => void;
  };
}
