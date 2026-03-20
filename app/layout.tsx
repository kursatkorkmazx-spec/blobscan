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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
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
