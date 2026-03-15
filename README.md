# BlobScan

A decentralized blob storage explorer and uploader built on the [Shelby Protocol](https://shelby.xyz) — the first cloud-grade hot storage network for Web3.

🌐 **Live:** [blobscan.vercel.app](https://blobscan.vercel.app)

---

## Features

### Explorer
- Search any Shelby wallet address
- View APT and ShelbyUSD balances
- List blobs with file previews, download and Explorer links
- Real-time network statistics (block height, TPS, total blobs, storage used)
- Matrix rain background animation

### Upload
- Connect Petra wallet (Aptos Wallet Standard)
- AES-256-GCM client-side encryption
- SHA-256 file integrity hashing
- Password strength indicator
- Auto-generated encryption keys
- ONE DOWNLOAD mode — file auto-consumes after first download
- Share link generation with embedded decryption key
- Expiration control (1 hour / 1 day / 7 days / 30 days)

### Vault
- Persistent upload history (localStorage)
- Status tracking: ACTIVE / EXPIRED / CONSUMED
- Vault statistics dashboard
- Filter by status
- PANIC WIPE — one-click purge of all records

### Protocol Log
- Full event log: WALLET_CONNECTED, FILE_ENCRYPTED, UPLOAD_COMPLETED, etc.
- Real-time tracking of all operations

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 |
| Language | TypeScript |
| Wallet | Aptos Wallet Adapter (Petra) |
| Storage SDK | @shelby-protocol/react |
| Encryption | Web Crypto API (AES-256-GCM, PBKDF2, SHA-256) |
| Deployment | Vercel |
| Network | Shelby shelbynet |

---

## Network

BlobScan connects to the Shelby shelbynet — a decentralized hot storage network co-developed by [Aptos Labs](https://aptoslabs.com) and [Jump Crypto](https://jumpcrypto.com).

- RPC: `https://api.shelbynet.shelby.xyz`
- Explorer: [explorer.shelby.xyz/shelbynet](https://explorer.shelby.xyz/shelbynet)

---

## Getting Started
```bash
git clone https://github.com/kursatkorkmazx-spec/blobscan.git
cd blobscan
npm install --legacy-peer-deps
npm run build -- --webpack
npm start
```

---

## Privacy & Security

- Private keys are never stored or transmitted
- Encryption happens entirely client-side
- No telemetry or tracking
- All data stays in your browser (localStorage)

---

Built by [@solscammer](https://twitter.com/solscammer) · Powered by [Shelby Protocol](https://shelby.xyz)
