"use client";
import { useState, useCallback, useEffect } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import QRCode from "qrcode";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import {
  createBlobKey,
  createDefaultErasureCodingProvider,
  expectedTotalChunksets,
  generateCommitments,
  ShelbyBlobClient,
} from "@shelby-protocol/sdk/browser";
import { shelbyClient } from "../shelbyClient";

function generateKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function passwordStrength(pw: string): { label: string; color: string; pct: number } {
  if (!pw) return { label: "—", color: "#333", pct: 0 };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: "WEAK", color: "#f87171", pct: 20 };
  if (score <= 3) return { label: "MEDIUM", color: "#facc15", pct: 60 };
  return { label: "STRONG", color: "#39FF14", pct: 100 };
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function fileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = { jpg: "Image", jpeg: "Image", png: "Image", gif: "Image", webp: "Image", mp4: "Video", pdf: "PDF", txt: "Text", zip: "Archive", json: "JSON", csv: "CSV" };
  return types[ext] || ext.toUpperCase() || "File";
}

async function encryptData(data: Uint8Array<ArrayBuffer>, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(data) as unknown as BufferSource);
  // Format: [salt(16)] [iv(12)] [ciphertext]
  const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);
  return result;
}

const SHELBY_DEPLOYER = "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";
const BLOB_REGISTER_EVENT = `${SHELBY_DEPLOYER}::blob_metadata::BlobRegisteredEvent`;

interface OnChainBlob {
  blobName: string;
  blobNameSuffix: string;
  size: number;
  expirationMicros: number;
  creationMicros: number;
  isWritten: boolean;
  isDeleted: boolean;
  txHash: string;
}

async function fetchAccountBlobs(address: string): Promise<OnChainBlob[]> {
  try {
    const res = await fetch(`https://api.shelbynet.shelby.xyz/v1/accounts/${address}/transactions?limit=100`);
    if (!res.ok) return [];
    const txns = await res.json();
    const blobs: OnChainBlob[] = [];
    const deletedNames = new Set<string>();
    const DELETE_EVENT = `${SHELBY_DEPLOYER}::blob_metadata::BlobDeletedEvent`;

    for (const tx of txns) {
      if (!tx.success) continue;
      for (const ev of tx.events || []) {
        if (ev.type === DELETE_EVENT) deletedNames.add(ev.data?.blob_name || "");
      }
    }
    for (const tx of txns) {
      if (!tx.success) continue;
      for (const ev of tx.events || []) {
        if (ev.type === BLOB_REGISTER_EVENT) {
          const d = ev.data;
          const fullName = d.blob_name || "";
          const suffix = fullName.includes("/") ? fullName.split("/").slice(1).join("/") : fullName;
          if (!blobs.some(b => b.blobName === fullName)) {
            blobs.push({
              blobName: fullName,
              blobNameSuffix: suffix,
              size: parseInt(d.blob_size || "0"),
              expirationMicros: parseInt(d.expiration_micros || "0"),
              creationMicros: parseInt(d.creation_micros || "0"),
              isWritten: true,
              isDeleted: deletedNames.has(fullName),
              txHash: tx.hash,
            });
          }
        }
      }
    }
    return blobs.sort((a, b) => b.creationMicros - a.creationMicros);
  } catch { return []; }
}

interface VaultRecord {
  id: string;
  name: string;
  size: number;
  hash: string;
  date: string;
  encrypted: boolean;
  key?: string;
  status: "ACTIVE" | "EXPIRED" | "CONSUMED";
  oneDownload: boolean;
  downloaded: boolean;
  expiration: string;
  shareLink?: string;
  blobName?: string;
  owner?: string;
  keyBlobName?: string;
  keyExpiration?: string;
}

interface FileInfo {
  file: File;
  hash: string;
  preview: string | null;
}

type EventType = "WALLET_CONNECTED" | "WALLET_DISCONNECTED" | "FILE_SELECTED" | "FILE_ENCRYPTED" | "UPLOAD_STARTED" | "UPLOAD_COMPLETED" | "UPLOAD_FAILED" | "RECORD_PERSISTED" | "LINK_CREATED" | "VAULT_WIPED" | "DOWNLOAD_CONSUMED" | "BLOB_DOWNLOADING" | "BLOB_DOWNLOADED" | "TX_SUBMITTED" | "TX_CONFIRMED" | "BLOB_REGISTERED" | "BLOB_UPLOADED";

interface ProtocolEvent {
  type: EventType;
  message: string;
  time: string;
}

export default function UploadClient() {
  const wallet = useWallet();
  const { account, connect, wallets, connected, disconnect } = wallet;
  const [fileInfos, setFileInfos] = useState<FileInfo[]>([]);
  const [expiration, setExpiration] = useState("86400");
  const [oneDownload, setOneDownload] = useState(false);
  const [keyLifetime, setKeyLifetime] = useState("300"); // 5 min default
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState("");
  const [autoKey, setAutoKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<"upload" | "vault" | "log">("upload");
  const [shareLink, setShareLink] = useState("");
  const [vault, setVault] = useState<VaultRecord[]>(() => {
    if (typeof window === "undefined") return [];
    return JSON.parse(localStorage.getItem("shelby_vault") || "[]");
  });
  const [events, setEvents] = useState<ProtocolEvent[]>(() => {
    if (typeof window === "undefined") return [];
    return JSON.parse(localStorage.getItem("shelby_events") || "[]");
  });
  const [vaultFilter, setVaultFilter] = useState<"ALL" | "ACTIVE" | "EXPIRED" | "CONSUMED">("ALL");

  const [isUploading, setIsUploading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [qrModal, setQrModal] = useState<{ url: string; dataUrl: string } | null>(null);

  async function showQR(url: string) {
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: "#39FF14", light: "#0f0f0f" } });
    setQrModal({ url, dataUrl });
  }

  const displayAddress = account?.address?.toString();
  const strength = passwordStrength(password);

  const [accountBlobs, setAccountBlobs] = useState<OnChainBlob[]>([]);

  // Fetch blobs when wallet connects
  const loadBlobs = useCallback(async () => {
    if (!displayAddress) return;
    const blobs = await fetchAccountBlobs(displayAddress);
    setAccountBlobs(blobs);
  }, [displayAddress]);

  // Auto-fetch on wallet connect
  useEffect(() => { loadBlobs(); }, [loadBlobs]);

  function addEvent(type: EventType, message: string) {
    const e: ProtocolEvent = { type, message, time: new Date().toLocaleTimeString() };
    setEvents(prev => {
      const updated = [e, ...prev].slice(0, 50);
      localStorage.setItem("shelby_events", JSON.stringify(updated));
      return updated;
    });
  }

  function saveVault(records: VaultRecord[]) {
    setVault(records);
    localStorage.setItem("shelby_vault", JSON.stringify(records));
  }

  async function processFiles(files: File[]) {
    const infos = await Promise.all(files.map(async (f) => {
      const buf = await f.arrayBuffer();
      const hash = await sha256(buf);
      const isImage = f.type.startsWith("image/");
      const preview = isImage ? URL.createObjectURL(f) : null;
      return { file: f, hash, preview };
    }));
    setFileInfos(infos);
    addEvent("FILE_SELECTED", `${files.length} file(s) selected`);
  }

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, []);

  const handleUpload = async () => {
    if (!connected || !account || fileInfos.length === 0) return;

    // For ONE-DL: force encryption with auto-generated key
    const isOneDL = oneDownload;
    const useEncryption = isOneDL ? true : encrypt;
    const finalPassword = isOneDL ? generateKey() : (autoKey ? generateKey() : password);

    setStatus("Processing files...");
    setIsUploading(true);
    setTxHash("");
    addEvent("UPLOAD_STARTED", `Uploading ${fileInfos.length} file(s) to Shelby network`);

    try {
      // Calculate expiration in microseconds
      const expirationSeconds = parseInt(expiration);
      const expirationMicros = (Date.now() + expirationSeconds * 1000) * 1000;
      const accountAddress = account.address.toString();

      // For ONE-DL: key blob has shorter expiration
      const keyLifetimeSec = parseInt(keyLifetime);
      const keyExpirationMicros = (Date.now() + keyLifetimeSec * 1000) * 1000;

      // Prepare blobs
      const blobsToUpload: { blobName: string; blobData: Uint8Array }[] = [];
      // Key blobs for ONE-DL (stored separately with short expiration)
      const keyBlobsToUpload: { blobName: string; blobData: Uint8Array }[] = [];

      for (let idx = 0; idx < fileInfos.length; idx++) {
        const fi = fileInfos[idx];
        const blobFileName = fi.file.name;
        let data = new Uint8Array(await fi.file.arrayBuffer());

        // Encrypt if enabled or ONE-DL
        if (useEncryption && finalPassword) {
          setStatus(`Encrypting ${blobFileName} (AES-256-GCM)...`);
          addEvent("FILE_ENCRYPTED", `AES-256-GCM encryption applied to ${blobFileName}`);
          data = await encryptData(data, finalPassword);
        }

        blobsToUpload.push({
          blobName: blobFileName,
          blobData: data,
        });

        // For ONE-DL: create a key blob containing the AES password
        if (isOneDL && finalPassword) {
          const keyBlobName = `${blobFileName}.shelbykey`;
          const keyData = new TextEncoder().encode(finalPassword);
          keyBlobsToUpload.push({
            blobName: keyBlobName,
            blobData: keyData,
          });
        }
      }

      // All blobs to register (file blobs + key blobs)
      const allBlobs = [...blobsToUpload, ...keyBlobsToUpload];

      // Step 1: Check which blobs already exist (try indexer, fallback to register all)
      let blobsToRegister = allBlobs;
      try {
        setStatus("Checking existing blobs...");
        const existingBlobs = await shelbyClient.coordination.getBlobs({
          where: {
            blob_name: {
              _in: allBlobs.map((blob) =>
                createBlobKey({
                  account: accountAddress,
                  blobName: blob.blobName,
                })
              ),
            },
          },
        });

        blobsToRegister = allBlobs.filter(
          (blob) =>
            !existingBlobs.some(
              (existingBlob) =>
                existingBlob.name ===
                createBlobKey({
                  account: accountAddress,
                  blobName: blob.blobName,
                })
            )
        );
      } catch (indexerErr) {
        console.warn("Indexer query failed (API key may be required), registering all blobs:", indexerErr);
        addEvent("BLOB_REGISTERED", "Indexer unavailable, registering all blobs");
      }

      // Step 2: Register blobs on-chain
      // For ONE-DL: file blobs and key blobs have DIFFERENT expirations
      // We need to split them into two batch register calls
      if (blobsToRegister.length > 0) {
        setStatus("Generating erasure coding commitments...");
        addEvent("BLOB_REGISTERED", `Generating commitments for ${blobsToRegister.length} blob(s)`);

        const provider = await createDefaultErasureCodingProvider();

        // Separate file blobs and key blobs for different expirations
        const fileBlobsToRegister = blobsToRegister.filter(b => !b.blobName.endsWith(".shelbykey"));
        const keyBlobsToRegister = blobsToRegister.filter(b => b.blobName.endsWith(".shelbykey"));

        const chunksetSize = provider.config.erasure_k * provider.config.chunkSizeBytes;

        // Register file blobs (normal expiration)
        if (fileBlobsToRegister.length > 0) {
          // Save sizes before generateCommitments which may detach the underlying ArrayBuffer
          const fileBlobSizes = fileBlobsToRegister.map(b => b.blobData.length);
          const fileCommitments = await Promise.all(
            fileBlobsToRegister.map(async (blob) => generateCommitments(provider, blob.blobData.slice()))
          );

          setStatus("Waiting for wallet approval (file registration)...");
          addEvent("TX_SUBMITTED", "Sending file register transaction...");

          const fileTx = await wallet.signAndSubmitTransaction({
            data: ShelbyBlobClient.createBatchRegisterBlobsPayload({
              account: AccountAddress.from(accountAddress),
              expirationMicros,
              blobs: fileBlobsToRegister.map((blob, index) => ({
                blobName: blob.blobName,
                blobSize: fileBlobSizes[index],
                blobMerkleRoot: fileCommitments[index].blob_merkle_root,
                numChunksets: expectedTotalChunksets(fileBlobSizes[index], chunksetSize),
              })),
              encoding: provider.config.enumIndex,
            }),
          });

          setTxHash(fileTx.hash);
          addEvent("TX_SUBMITTED", `File TX submitted: ${fileTx.hash}`);
          setStatus("Waiting for file TX confirmation...");
          await shelbyClient.coordination.aptos.waitForTransaction({ transactionHash: fileTx.hash });
          addEvent("TX_CONFIRMED", `File TX confirmed: ${fileTx.hash}`);
        }

        // Register key blobs (short expiration) — separate TX!
        if (keyBlobsToRegister.length > 0) {
          const keyBlobSizes = keyBlobsToRegister.map(b => b.blobData.length);
          const keyCommitments = await Promise.all(
            keyBlobsToRegister.map(async (blob) => generateCommitments(provider, blob.blobData.slice()))
          );

          setStatus("Waiting for wallet approval (key blob registration)...");
          addEvent("TX_SUBMITTED", "Registering self-destructing key blob...");

          const keyTx = await wallet.signAndSubmitTransaction({
            data: ShelbyBlobClient.createBatchRegisterBlobsPayload({
              account: AccountAddress.from(accountAddress),
              expirationMicros: keyExpirationMicros,
              blobs: keyBlobsToRegister.map((blob, index) => ({
                blobName: blob.blobName,
                blobSize: keyBlobSizes[index],
                blobMerkleRoot: keyCommitments[index].blob_merkle_root,
                numChunksets: expectedTotalChunksets(keyBlobSizes[index], chunksetSize),
              })),
              encoding: provider.config.enumIndex,
            }),
          });

          addEvent("TX_SUBMITTED", `Key TX submitted: ${keyTx.hash}`);
          setStatus("Waiting for key TX confirmation...");
          await shelbyClient.coordination.aptos.waitForTransaction({ transactionHash: keyTx.hash });
          addEvent("TX_CONFIRMED", `Key blob registered with ${keyLifetimeSec}s expiration`);
        }

        setStatus("Transactions confirmed! Uploading blob data...");
      } else {
        addEvent("BLOB_REGISTERED", "Blobs already registered on-chain, skipping TX");
      }

      // Step 3: Upload blob data to RPC (file blobs + key blobs)
      setStatus("Uploading blob data to storage providers...");
      for (const blob of allBlobs) {
        addEvent("BLOB_UPLOADED", `Uploading ${blob.blobName} to RPC...`);
        await shelbyClient.rpc.putBlob({
          account: accountAddress,
          blobName: blob.blobName,
          blobData: blob.blobData,
        });
        addEvent("BLOB_UPLOADED", `${blob.blobName} uploaded to storage providers`);
      }

      // Create vault records
      const keyLifetimeLabel = keyLifetimeSec === 60 ? "1 min" : keyLifetimeSec === 300 ? "5 min" : keyLifetimeSec === 600 ? "10 min" : `${keyLifetimeSec}s`;
      const newRecords: VaultRecord[] = fileInfos.map((fi, idx) => {
        const ownerAddr = accountAddress;
        const blobFileName = fi.file.name;
        const keyBlobName = isOneDL ? `${blobFileName}.shelbykey` : undefined;
        // ONE-DL link: no key in URL, key is fetched from on-chain blob
        const link = isOneDL
          ? `${window.location.origin}/?address=${ownerAddr}&blob=${encodeURIComponent(blobFileName)}&keyBlob=${encodeURIComponent(keyBlobName!)}&oneDownload=true`
          : `${window.location.origin}/?address=${ownerAddr}&blob=${encodeURIComponent(blobFileName)}${useEncryption && finalPassword ? `&key=${encodeURIComponent(finalPassword)}` : ""}`;
        return {
          id: `blob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: blobFileName,
          size: fi.file.size,
          hash: fi.hash,
          date: new Date().toLocaleString(),
          encrypted: useEncryption && !!finalPassword,
          key: useEncryption ? finalPassword : undefined,
          status: "ACTIVE" as const,
          oneDownload: isOneDL,
          downloaded: false,
          expiration: expirationSeconds === 3600 ? "1 hour" : expirationSeconds === 86400 ? "1 day" : expirationSeconds === 604800 ? "7 days" : "30 days",
          shareLink: link,
          blobName: blobFileName,
          owner: ownerAddr,
          keyBlobName,
          keyExpiration: isOneDL ? keyLifetimeLabel : undefined,
        };
      });

      const updated = [...vault, ...newRecords];
      saveVault(updated);
      addEvent("UPLOAD_COMPLETED", `${fileInfos.length} file(s) uploaded successfully`);
      addEvent("RECORD_PERSISTED", `${fileInfos.length} record(s) saved to vault`);
      addEvent("LINK_CREATED", `Share link generated`);

      setShareLink(newRecords[0]?.shareLink || "");
      setFileInfos([]);
      setStatus("Upload complete!");

      // Refresh blob list
      loadBlobs();

      setTimeout(() => setStatus(""), 8000);
    } catch (err: any) {
      const msg = err?.message || "Upload failed";
      setStatus(`Error: ${msg}`);
      addEvent("UPLOAD_FAILED", msg);
      console.error("Upload error:", err);
      setTimeout(() => setStatus(""), 8000);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownloadBlob = async (record: VaultRecord) => {
    if (!record.blobName || !record.owner) return;
    try {
      addEvent("BLOB_DOWNLOADING", `Downloading ${record.name} from Shelby network...`);
      setStatus(`Downloading ${record.name}...`);

      const blob = await shelbyClient.download({
        account: record.owner,
        blobName: record.blobName,
      });

      // Read the stream into a Uint8Array
      const reader = blob.readable.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }
      let data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      // Decrypt if encrypted and key available
      if (record.encrypted && record.key) {
        try {
          const salt = data.slice(0, 16);
          const iv = data.slice(16, 28);
          const ciphertext = data.slice(28);
          const enc = new TextEncoder();
          const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(record.key), "PBKDF2", false, ["deriveKey"]);
          const cryptoKey = await crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
          );
          const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
          data = new Uint8Array(decrypted);
        } catch {
          addEvent("UPLOAD_FAILED", "Decryption failed - wrong key?");
        }
      }

      // Trigger browser download
      const downloadBlob = new Blob([data]);
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = record.name;
      a.click();
      URL.revokeObjectURL(url);

      addEvent("BLOB_DOWNLOADED", `${record.name} downloaded successfully`);

      // Mark as consumed if oneDownload
      if (record.oneDownload) {
        const updated = vault.map(r =>
          r.id === record.id ? { ...r, status: "CONSUMED" as const, downloaded: true } : r
        );
        saveVault(updated);
        addEvent("DOWNLOAD_CONSUMED", `${record.name} consumed after download`);
      }

      setStatus("");
    } catch (err: any) {
      setStatus(`Error: ${err?.message || "Download failed"}`);
      addEvent("UPLOAD_FAILED", `Download failed: ${err?.message}`);
      setTimeout(() => setStatus(""), 5000);
    }
  };

  function panicWipe() {
    if (!confirm("Wipe ALL vault records and logs? This cannot be undone.")) return;
    saveVault([]);
    setEvents([]);
    localStorage.removeItem("shelby_vault");
    localStorage.removeItem("shelby_events");
    addEvent("VAULT_WIPED", "All records purged");
    setShareLink("");
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  const filteredVault = vault.filter(r => vaultFilter === "ALL" || r.status === vaultFilter);
  const stats = { total: vault.length, active: vault.filter(r => r.status === "ACTIVE").length, expired: vault.filter(r => r.status === "EXPIRED").length, consumed: vault.filter(r => r.status === "CONSUMED").length };

  const btn = { background: "#39FF14", color: "#0a0a0a", border: "none", borderRadius: "8px", padding: "9px 20px", fontSize: "13px", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" } as const;
  const card = { background: "#161616", border: "1px solid #222", borderRadius: "12px", padding: "20px", marginBottom: "14px" } as const;
  const tab = (active: boolean) => ({ background: "transparent", border: "none", borderBottom: active ? "2px solid #39FF14" : "2px solid transparent", color: active ? "#39FF14" : "#666", fontSize: "13px", cursor: "pointer", padding: "8px 16px", marginRight: "4px", fontFamily: "inherit" } as const);

  return (
    <main style={{ display: "flex", background: "#0d0d0d", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{ width: "190px", minHeight: "100vh", background: "#111", borderRight: "1px solid #1f1f1f", display: "flex", flexDirection: "column", flexShrink: 0, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50 }}>
        <div style={{ padding: "16px 14px 14px", borderBottom: "1px solid #1f1f1f" }}>
          <a href="/" style={{ textDecoration: "none" }}>
            <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "14px", color: "#39FF14", textShadow: "0 0 8px rgba(57,255,20,0.6)", letterSpacing: "1px" }}>
              BLOBSCAN
            </div>
            <div style={{ fontSize: "10px", color: "#666", marginTop: "8px" }}>Shelby Network</div>
          </a>
        </div>
        <nav style={{ padding: "10px 0", flex: 1 }}>
          {[{ label: "Home", href: "/", icon: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", active: false },
            { label: "Upload", href: "/upload", icon: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12", active: true },
            { label: "Explorer ↗", href: "https://explorer.shelby.xyz/shelbynet", icon: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3", active: false },
          ].map(item => (
            <a key={item.label} href={item.href} target={item.label.includes("↗") ? "_blank" : undefined} style={{ textDecoration: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 16px", borderRadius: "8px", margin: "2px 10px", fontSize: "14px", color: item.active ? "#39FF14" : "#aaa", background: item.active ? "rgba(57,255,20,0.1)" : "transparent", fontWeight: item.active ? 600 : 400 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg>
                {item.label}
              </div>
            </a>
          ))}
        </nav>
        <div style={{ borderTop: "1px solid #1f1f1f", padding: "14px 16px", fontSize: "10px", color: "#666" }}>
          by <a href="https://twitter.com/solscammer" target="_blank" style={{ color: "#666", textDecoration: "none" }}>@solscammer</a>
        </div>
      </aside>

      {/* Wallet — fixed top-right (same as home page) */}
      <div style={{ position: "fixed", top: "12px", right: "24px", zIndex: 100, display: "flex", alignItems: "center", gap: "8px" }}>
        {connected ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "5px 12px", fontSize: "12px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#39FF14", display: "inline-block" }} />
              <span style={{ color: "#aaa" }}>{displayAddress?.slice(0, 6)}…{displayAddress?.slice(-4)}</span>
            </div>
            <button onClick={() => { disconnect(); addEvent("WALLET_DISCONNECTED", "Wallet disconnected"); }}
              style={{ background: "transparent", border: "1px solid #333", borderRadius: "8px", padding: "5px 10px", color: "#aaa", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>Disconnect</button>
          </>
        ) : (
          <>
            {wallets.filter(w => w.name === "Petra").map(w => (
              <button key={w.name} onClick={() => { connect(w.name); addEvent("WALLET_CONNECTED", `${w.name} connected`); }}
                style={{ background: "#39FF14", color: "#0a0a0a", border: "none", borderRadius: "8px", padding: "5px 14px", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <a href="https://petra.app" target="_blank" style={{ background: "transparent", border: "1px solid #333", borderRadius: "8px", padding: "5px 12px", color: "#aaa", fontSize: "12px", textDecoration: "none" }}>Install Petra</a>
            )}
          </>
        )}
      </div>

      {/* Main */}
      <div style={{ marginLeft: "190px", flex: 1, minHeight: "100vh", paddingBottom: "32px", width: "calc(100% - 190px)" }}>
      <div className="upload-root" style={{ maxWidth: "800px", margin: "0 auto", color: "#e5e5e5", padding: "28px 24px" }}>

      {qrModal && (
        <div onClick={() => setQrModal(null)} style={{ display: "flex", position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.88)", zIndex: 1000, alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "10px", padding: "24px", maxWidth: "340px", width: "90%", textAlign: "center" as const }}>
            <div style={{ fontSize: "13px", color: "#39FF14", marginBottom: "12px", fontWeight: "bold" }}>QR Kod — Share Link</div>
            <img src={qrModal.dataUrl} style={{ width: "280px", height: "280px", borderRadius: "8px", border: "1px solid #2a2a2a" }} alt="QR Code" />
            <div style={{ fontSize: "10px", color: "#444", marginTop: "10px", wordBreak: "break-all", maxHeight: "40px", overflow: "hidden" }}>{qrModal.url}</div>
            <div style={{ display: "flex", gap: "8px", marginTop: "14px", justifyContent: "center" }}>
              <button onClick={() => copyToClipboard(qrModal.url)} style={{ background: "transparent", border: "1px solid rgba(57,255,20,0.4)", borderRadius: "4px", padding: "6px 14px", color: "#39FF14",  fontSize: "11px", cursor: "pointer" }}>Copy Link</button>
              <button onClick={() => {
                const a = document.createElement("a");
                a.href = qrModal.dataUrl;
                a.download = "qr-code.png";
                a.click();
              }} style={{ background: "transparent", border: "1px solid #555", borderRadius: "4px", padding: "6px 14px", color: "#888",  fontSize: "11px", cursor: "pointer" }}>Download PNG</button>
              <button onClick={() => setQrModal(null)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 14px", color: "#555",  fontSize: "11px", cursor: "pointer" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Centered title */}
      <div style={{ textAlign: "center", marginBottom: "28px", paddingTop: "8px" }}>
        <h1 style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "clamp(18px, 3vw, 28px)", color: "#39FF14", textShadow: "0 0 10px rgba(57,255,20,0.5)", marginBottom: "10px", letterSpacing: "1px" }}>UPLOAD</h1>
        <p style={{ color: "#777", fontSize: "12px", margin: 0 }}>Shelby Network · AES-256-GCM · SHA-256 integrity</p>
      </div>

      {!connected ? (
        <div style={card}>
          <p style={{ color: "#888", fontSize: "13px", margin: "0 0 16px" }}>Connect your Petra wallet to upload files to the Shelby network.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {wallets.filter(w => w.name === "Petra").map((w) => (
              <button key={w.name} onClick={() => { connect(w.name); addEvent("WALLET_CONNECTED", `${w.name} connected`); }} style={btn}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <p style={{ color: "#555", fontSize: "12px" }}>No wallets detected. Install <a href="https://petra.app" target="_blank" style={{ color: "#39FF14" }}>Petra</a>.</p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div style={{ borderBottom: "1px solid #2a2a2a", marginBottom: "20px" }}>
            <button style={tab(activeTab === "upload")} onClick={() => setActiveTab("upload")}>Upload</button>
            <button style={tab(activeTab === "vault")} onClick={() => setActiveTab("vault")}>Vault {vault.length > 0 && `(${vault.length})`}</button>
            <button style={tab(activeTab === "log")} onClick={() => setActiveTab("log")}>Protocol Log {events.length > 0 && `(${events.length})`}</button>
          </div>

          {activeTab === "upload" && (
            <div>
              <div style={card}>
                <div style={{ border: dragging ? "1px dashed #39FF14" : "1px dashed #2a2a2a", borderRadius: "6px", padding: fileInfos.length > 0 ? "16px" : "40px", textAlign: "center" as const, cursor: "pointer", color: "#555", marginBottom: "16px" }}
                  onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                  onClick={() => document.getElementById("fi")?.click()}>
                  {fileInfos.length > 0 ? (
                    <div style={{ textAlign: "left" as const }}>
                      {fileInfos.map((fi, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px 0", borderBottom: i < fileInfos.length - 1 ? "1px solid #2a2a2a" : "none" }}>
                          {fi.preview ? <img src={fi.preview} style={{ width: "48px", height: "48px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2a2a2a" }} /> : <div style={{ width: "48px", height: "48px", background: "#111", borderRadius: "4px", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>📄</div>}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ marginBottom: "2px" }}>
                              <span style={{ color: "#e5e5e5", fontSize: "13px", fontFamily: "inherit" }}>{fi.file.name}</span>
                            </div>
                            <div style={{ color: "#555", fontSize: "11px" }}>{fileType(fi.file.name)} · {formatSize(fi.file.size)}</div>
                            <div style={{ color: "#333", fontSize: "10px", marginTop: "2px" }}>SHA-256: {fi.hash.slice(0, 16)}...{fi.hash.slice(-8)}</div>
                          </div>
                        </div>
                      ))}
                      <div style={{ textAlign: "center" as const, paddingTop: "8px", fontSize: "12px", color: "#444" }}>Click to add more files</div>
                    </div>
                  ) : "Click or drag files here"}
                </div>
                <input id="fi" type="file" multiple style={{ display: "none" }} onChange={(e) => processFiles(Array.from(e.target.files || []))} />

                <div style={{ background: "#111", borderRadius: "6px", border: "1px solid #2a2a2a", padding: "12px", marginBottom: "12px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginBottom: "8px" }}>
                    <input type="checkbox" checked={encrypt} onChange={e => setEncrypt(e.target.checked)} />
                    Enable AES-256-GCM encryption
                  </label>
                  {encrypt && (
                    <>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginBottom: "8px" }}>
                        <input type="checkbox" checked={autoKey} onChange={e => setAutoKey(e.target.checked)} />
                        Auto-generate key
                      </label>
                      {!autoKey && (
                        <>
                          <div style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
                            <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Encryption password" type={showPassword ? "text" : "password"}
                              style={{ flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", color: "#e0e0e0",  fontSize: "12px" }} />
                            <button onClick={() => setShowPassword(!showPassword)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", cursor: "pointer", fontSize: "11px" }}>{showPassword ? "Hide" : "Show"}</button>
                            <button onClick={() => setPassword(generateKey())} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555", cursor: "pointer", fontSize: "11px" }}>GEN</button>
                          </div>
                          {password && (
                            <div style={{ marginBottom: "4px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: strength.color, marginBottom: "3px" }}>
                                <span>Strength</span><span>{strength.label}</span>
                              </div>
                              <div style={{ background: "#2a2a2a", borderRadius: "2px", height: "3px" }}>
                                <div style={{ background: strength.color, width: `${strength.pct}%`, height: "3px", borderRadius: "2px", transition: "width 0.3s" }} />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#888", marginTop: "8px" }}>
                    <input type="checkbox" checked={oneDownload} onChange={e => setOneDownload(e.target.checked)} />
                    ⏳ TIME-LIMITED — on-chain enforced (key blob self-destructs)
                  </label>
                  {oneDownload && (
                    <div style={{ marginTop: "8px", marginLeft: "24px" }}>
                      <div style={{ fontSize: "11px", color: "#f87171", marginBottom: "6px" }}>
                        File will be AES-256-GCM encrypted. Decryption key stored on-chain and destroyed after the selected time window.
                        After expiration, the key is gone — file becomes permanently undecryptable.
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "11px", color: "#888" }}>Access window:</span>
                        <select value={keyLifetime} onChange={e => setKeyLifetime(e.target.value)}
                          style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#f87171", fontSize: "11px" }}>
                          <option value="60">1 minute</option>
                          <option value="300">5 minutes</option>
                          <option value="600">10 minutes</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                  <select value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "8px", color: "#e0e0e0", fontFamily: "inherit" }}>
                    <option value="3600">1 hour</option>
                    <option value="86400">1 day</option>
                    <option value="604800">7 days</option>
                    <option value="2592000">30 days</option>
                  </select>
                  <button onClick={handleUpload} disabled={fileInfos.length === 0 || isUploading} style={{ ...btn, padding: "8px 20px", fontSize: "13px", opacity: fileInfos.length === 0 || isUploading ? 0.5 : 1 }}>
                    {isUploading ? "Uploading…" : "Upload"}
                  </button>
                </div>

                {status && <div style={{ fontSize: "12px", color: status.startsWith("Error") ? "#f87171" : "#39FF14", marginBottom: "8px" }}>{status}</div>}

                {txHash && (
                  <div style={{ background: "#0a0a1a", border: "1px solid #1a1a3a", borderRadius: "6px", padding: "12px", marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", color: "#e5e5e5", marginBottom: "6px" }}>Transaction Hash:</div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <code style={{ flex: 1, fontSize: "10px", color: "#888", wordBreak: "break-all" }}>{txHash}</code>
                      <button onClick={() => copyToClipboard(txHash)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#39FF14", cursor: "pointer", fontSize: "11px", whiteSpace: "nowrap" }}>Copy</button>
                      <a href={`https://explorer.aptoslabs.com/txn/${txHash}?network=shelbynet`} target="_blank" style={{ color: "#e5e5e5", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid #2a2a4a", borderRadius: "4px", whiteSpace: "nowrap" }}>View TX</a>
                    </div>
                  </div>
                )}

                {shareLink && (
                  <div style={{ background: "#0a1a0a", border: "1px solid #1a3a1a", borderRadius: "6px", padding: "12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <div style={{ fontSize: "11px", color: "#39FF14" }}>Share Link (blob stored on Shelby network):</div>
                      <button onClick={() => setShareLink("")} style={{ background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: "0 2px" }}>×</button>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input readOnly value={shareLink} style={{ flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", color: "#888",  fontSize: "10px" }} />
                      <button onClick={() => copyToClipboard(shareLink)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#39FF14", cursor: "pointer", fontSize: "11px" }}>Copy</button>
                      <button onClick={() => showQR(shareLink)} style={{ background: "transparent", border: "1px solid rgba(57,255,20,0.4)", borderRadius: "4px", padding: "4px 8px", color: "#39FF14", cursor: "pointer", fontSize: "11px" }}>QR</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Show on-chain blobs for this account */}
              {accountBlobs && accountBlobs.length > 0 && (
                <div style={card}>
                  <h2 style={{ margin: "0 0 12px", fontSize: "13px", color: "#888", textTransform: "uppercase" as const, letterSpacing: "1px" }}>Your On-Chain Blobs ({accountBlobs.length})</h2>
                  {accountBlobs.map((blob, i) => (
                    <div key={i} style={{ borderBottom: "1px solid #2a2a2a", padding: "8px 0", fontSize: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ color: "#e5e5e5" }}>{blob.blobNameSuffix}</span>
                        <div style={{ color: "#555", fontSize: "11px" }}>
                          {formatSize(blob.size)} · Expires: {new Date(blob.expirationMicros / 1000).toLocaleString()}
                          {blob.isWritten && <span style={{ color: "#39FF14", marginLeft: "6px" }}>● Written</span>}
                        </div>
                      </div>
                      <a href={`https://explorer.shelby.xyz/shelbynet/account/${displayAddress}/blobs?name=${encodeURIComponent(blob.blobNameSuffix)}`}
                        target="_blank" style={{ color: "#39FF14", fontSize: "11px", textDecoration: "none", padding: "4px 8px", border: "1px solid rgba(57,255,20,0.4)", borderRadius: "4px" }}>Explorer</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "vault" && (
            <div>
              <div className="vault-stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px", marginBottom: "16px" }}>
                {[["TOTAL", stats.total, "#a0c4ff"], ["ACTIVE", stats.active, "#39FF14"], ["EXPIRED", stats.expired, "#facc15"], ["CONSUMED", stats.consumed, "#f87171"]].map(([label, count, color]) => (
                  <div key={label as string} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "12px", textAlign: "center" as const }}>
                    <div style={{ fontSize: "18px", color: color as string, fontWeight: "bold" }}>{count}</div>
                    <div style={{ fontSize: "10px", color: "#555" }}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
                {(["ALL", "ACTIVE", "EXPIRED", "CONSUMED"] as const).map(f => (
                  <button key={f} onClick={() => setVaultFilter(f)}
                    style={{ background: vaultFilter === f ? "#39FF14" : "transparent", color: vaultFilter === f ? "#0f0f0f" : "#555", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 10px",  fontSize: "11px", cursor: "pointer" }}>{f}</button>
                ))}
                <button onClick={panicWipe} style={{ marginLeft: "auto", background: "transparent", border: "1px solid #f87171", borderRadius: "4px", padding: "4px 10px", color: "#f87171",  fontSize: "11px", cursor: "pointer" }}>⚠ PANIC WIPE</button>
              </div>

              {filteredVault.length === 0 ? (
                <div style={{ color: "#444", fontSize: "13px", padding: "20px 0", textAlign: "center" as const }}>No records found.</div>
              ) : filteredVault.map((r) => (
                <div key={r.id} style={{ ...card, marginBottom: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                    <span style={{ color: "#e5e5e5", fontSize: "13px" }}>{r.name}</span>
                    <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "3px", background: r.status === "ACTIVE" ? "#1a3a2a" : r.status === "EXPIRED" ? "#3a3010" : "#3a1010", color: r.status === "ACTIVE" ? "#39FF14" : r.status === "EXPIRED" ? "#facc15" : "#f87171" }}>{r.status}</span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#555", marginBottom: "4px" }}>
                    {formatSize(r.size)} · {r.date} · Expires: {r.expiration}
                    {r.encrypted && <span style={{ marginLeft: "6px", color: "#60a5fa" }}>🔒 AES-256</span>}
                    {r.oneDownload && <span style={{ marginLeft: "6px", color: "#f87171" }}>⏳ TIME-LIMITED</span>}
                    {r.keyBlobName && <span style={{ marginLeft: "6px", color: "#f87171" }}>Key expires: {r.keyExpiration}</span>}
                  </div>
                  <div style={{ fontSize: "10px", color: "#333", marginBottom: "6px" }}>ID: {r.id} · SHA-256: {r.hash.slice(0, 12)}...</div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {r.shareLink && (
                      <>
                        <input readOnly value={r.shareLink} style={{ flex: 1, minWidth: "120px", background: "#111", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "4px 8px", color: "#555",  fontSize: "10px" }} />
                        <button onClick={() => copyToClipboard(r.shareLink!)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "3px 6px", color: "#39FF14", cursor: "pointer", fontSize: "10px" }}>Copy</button>
                        <button onClick={() => showQR(r.shareLink!)} style={{ background: "transparent", border: "1px solid rgba(57,255,20,0.4)", borderRadius: "4px", padding: "3px 6px", color: "#39FF14", cursor: "pointer", fontSize: "10px" }}>QR</button>
                      </>
                    )}
                    {r.status === "ACTIVE" && r.blobName && r.owner && (
                      <button onClick={() => handleDownloadBlob(r)} style={{ background: "transparent", border: "1px solid rgba(57,255,20,0.4)", borderRadius: "4px", padding: "3px 8px", color: "#39FF14", cursor: "pointer", fontSize: "10px" }}>Download</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "log" && (
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <h2 style={{ margin: 0, fontSize: "13px", color: "#888", textTransform: "uppercase" as const, letterSpacing: "1px" }}>Protocol Events</h2>
                <button onClick={() => { setEvents([]); localStorage.removeItem("shelby_events"); }} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "3px 8px", color: "#555",  fontSize: "11px", cursor: "pointer" }}>Clear</button>
              </div>
              {events.length === 0 ? (
                <div style={{ color: "#444", fontSize: "13px" }}>No events yet.</div>
              ) : events.map((e, i) => (
                <div key={i} style={{ borderBottom: "1px solid #2a2a2a", padding: "6px 0", fontSize: "12px", display: "flex", gap: "10px" }}>
                  <span style={{ color: "#333", minWidth: "60px" }}>{e.time}</span>
                  <span style={{ color: e.type.includes("FAILED") || e.type === "VAULT_WIPED" ? "#f87171" : e.type.includes("COMPLETED") || e.type.includes("DOWNLOADED") ? "#39FF14" : "#39FF14", minWidth: "140px" }}>{e.type}</span>
                  <span style={{ color: "#555" }}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      </div>
      </div>
    </main>
  );
}
