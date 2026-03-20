"use client";
import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";
import { ShelbyClientProvider } from "@shelby-protocol/react";
import { shelbyClient } from "./shelbyClient";

const queryClient = new QueryClient();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <QueryClientProvider client={queryClient}>
          <AptosWalletAdapterProvider
            autoConnect={true}
            dappConfig={{ network: Network.SHELBYNET }}
            onError={(e) => console.error(e)}
          >
            <ShelbyClientProvider client={shelbyClient}>
              {children}
            </ShelbyClientProvider>
          </AptosWalletAdapterProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
