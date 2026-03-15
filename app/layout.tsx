"use client";
import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";

const queryClient = new QueryClient();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <QueryClientProvider client={queryClient}>
          <AptosWalletAdapterProvider
            autoConnect={false}
            dappConfig={{ network: Network.TESTNET }}
            onError={(e) => console.error(e)}
          >
            {children}
          </AptosWalletAdapterProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
