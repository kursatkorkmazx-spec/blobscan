"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import {
  ShelbyBlobClient,
  createDefaultErasureCodingProvider,
  generateCommitments,
  expectedTotalChunksets,
} from "@shelby-protocol/sdk/browser";
import { shelbyClient } from "../shelbyClient";

// ─── Types ────────────────────────────────────────────────────────────────────
type Theme = "abyss" | "cosmic" | "neon" | "midnight";

interface ThemeConfig {
  label: string;
  bg1: string;
  bg2: string;
  accent: string;
  cardBorder: string;
  textPrimary: string;
  textSecondary: string;
  badgeBg: string;
  badgeBorder: string;
  divider: string;
}

interface MintRecord {
  address: string;
  blobName: string;
  mintedAt: number;
  theme: Theme;
}

// ─── Theme definitions ─────────────────────────────────────────────────────────
const THEMES: Record<Theme, ThemeConfig> = {
  abyss: {
    label: "Abyss",
    bg1: "#0a0a14",
    bg2: "#111128",
    accent: "#7c5cfc",
    cardBorder: "rgba(124,92,252,0.35)",
    textPrimary: "#e8e5ff",
    textSecondary: "#8882bb",
    badgeBg: "rgba(124,92,252,0.15)",
    badgeBorder: "rgba(124,92,252,0.6)",
    divider: "rgba(124,92,252,0.2)",
  },
  cosmic: {
    label: "Cosmic Ray",
    bg1: "#090d1a",
    bg2: "#0d1426",
    accent: "#38bdf8",
    cardBorder: "rgba(56,189,248,0.3)",
    textPrimary: "#e0f2fe",
    textSecondary: "#7eb0cc",
    badgeBg: "rgba(56,189,248,0.1)",
    badgeBorder: "rgba(56,189,248,0.5)",
    divider: "rgba(56,189,248,0.15)",
  },
  neon: {
    label: "Neon Core",
    bg1: "#060d06",
    bg2: "#0a150a",
    accent: "#39FF14",
    cardBorder: "rgba(57,255,20,0.3)",
    textPrimary: "#e5ffe0",
    textSecondary: "#6aaa60",
    badgeBg: "rgba(57,255,20,0.08)",
    badgeBorder: "rgba(57,255,20,0.5)",
    divider: "rgba(57,255,20,0.15)",
  },
  midnight: {
    label: "Midnight",
    bg1: "#0a0a0a",
    bg2: "#141414",
    accent: "#e5e5e5",
    cardBorder: "rgba(255,255,255,0.12)",
    textPrimary: "#f5f5f5",
    textSecondary: "#666",
    badgeBg: "rgba(255,255,255,0.05)",
    badgeBorder: "rgba(255,255,255,0.25)",
    divider: "rgba(255,255,255,0.08)",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function addrToId(addr: string): string {
  const clean = addr.replace("0x", "");
  return `${clean.slice(0, 4).toUpperCase()}-${clean.slice(4, 8).toUpperCase()}`;
}

// Deterministic color palette from address
function addrToColors(addr: string): string[] {
  const clean = addr.replace("0x", "").padEnd(64, "0");
  const h1 = parseInt(clean.slice(0, 4), 16) % 360;
  const h2 = (h1 + 137) % 360;
  const h3 = (h1 + 222) % 360;
  return [
    `hsl(${h1}, 70%, 60%)`,
    `hsl(${h2}, 75%, 55%)`,
    `hsl(${h3}, 65%, 65%)`,
  ];
}

// ─── Canvas card renderer ──────────────────────────────────────────────────────
function drawCard(
  canvas: HTMLCanvasElement,
  address: string,
  theme: ThemeConfig,
  scale: number = 1,
  showPlaceholders: boolean = true
) {
  const W = 760 * scale;
  const H = 420 * scale;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const w = 760;
  const h = 420;

  const colors = addrToColors(address);

  // ── Background gradient
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, theme.bg1);
  grad.addColorStop(1, theme.bg2);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 20);
  ctx.fill();


  // ── Card border glow
  ctx.save();
  ctx.strokeStyle = theme.cardBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(0.75, 0.75, w - 1.5, h - 1.5, 20);
  ctx.stroke();
  ctx.restore();

  // ── Header divider line
  ctx.save();
  ctx.strokeStyle = theme.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(28, 72);
  ctx.lineTo(w - 28, 72);
  ctx.stroke();
  ctx.restore();

  // ── Star icon (top-left)
  ctx.save();
  ctx.fillStyle = theme.accent;
  ctx.font = "bold 20px Arial";
  ctx.fillText("✦", 28, 48);
  ctx.restore();

  // ── BLOBCARD logo
  ctx.save();
  ctx.fillStyle = theme.accent;
  ctx.font = `bold 22px 'Courier New', monospace`;
  ctx.letterSpacing = "2px";
  ctx.fillText("BLOBCARD", 56, 48);
  ctx.restore();

  // ── TESTCARD badge (top-right)
  const badgeW = 90;
  const badgeH = 26;
  const badgeX = w - 28 - badgeW;
  const badgeY = 24;
  ctx.save();
  ctx.fillStyle = theme.badgeBg;
  ctx.strokeStyle = theme.badgeBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.textPrimary;
  ctx.font = "bold 10px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillText("TESTCARD", badgeX + badgeW / 2, badgeY + 17);
  ctx.restore();

  // ── User info (top-left of content area)
  const infoX = 36;
  const infoY = 90;
  ctx.save();
  ctx.fillStyle = theme.textPrimary;
  ctx.font = "bold 26px Georgia, serif";
  ctx.textAlign = "left";
  ctx.fillText(shortAddr(address), infoX, infoY + 28);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = theme.textSecondary;
  ctx.font = "14px 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.fillText(`@${address.slice(0, 10)}…${address.slice(-6)}`, infoX, infoY + 54);
  ctx.restore();

  // ── Drawing area placeholder (preview only)
  const drawAreaY = 162;
  const drawAreaH = h - 250;
  if (showPlaceholders) {
    ctx.save();
    ctx.strokeStyle = `${theme.accent}33`;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.roundRect(36, drawAreaY, w - 72, drawAreaH, 8);
    ctx.stroke();
    ctx.restore();
  }

  // ── Bottom divider
  ctx.save();
  ctx.strokeStyle = theme.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(28, h - 68);
  ctx.lineTo(w - 28, h - 68);
  ctx.stroke();
  ctx.restore();

  // ── ID label (bottom left)
  ctx.save();
  ctx.fillStyle = theme.textSecondary;
  ctx.font = "13px 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.fillText(`ID: ${addrToId(address)}`, 36, h - 38);
  ctx.restore();

  // ── Signature area (preview only)
  const sigX = w - 228;
  const sigY = h - 62;
  const sigW = 190;
  const sigH = 46;
  if (showPlaceholders) {
    ctx.save();
    ctx.strokeStyle = `${theme.accent}44`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.roundRect(sigX, sigY, sigW, sigH, 4);
    ctx.stroke();
    ctx.restore();
  }
}

// ─── Blob avatar (generative from address) ─────────────────────────────────────
function drawBlobAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colors: string[],
  address: string
) {
  const clean = address.replace("0x", "").padEnd(64, "0");
  const seed = (i: number) => parseInt(clean.slice(i * 2, i * 2 + 2) || "80", 16) / 255;

  // Blob shape
  ctx.save();
  ctx.beginPath();
  const pts = 8;
  for (let i = 0; i < pts; i++) {
    const angle = (i / pts) * Math.PI * 2 - Math.PI / 2;
    const blobR = r * (0.82 + seed(i) * 0.28);
    const x = cx + Math.cos(angle) * blobR;
    const y = cy + Math.sin(angle) * blobR;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const avatarGrad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r * 1.1);
  avatarGrad.addColorStop(0, colors[0]);
  avatarGrad.addColorStop(0.6, colors[1]);
  avatarGrad.addColorStop(1, colors[2]);
  ctx.fillStyle = avatarGrad;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Eyes
  const eyeY = cy - r * 0.15;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.arc(cx - r * 0.28, eyeY, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.28, eyeY, r * 0.1, 0, Math.PI * 2);
  ctx.fill();

  // Eye shine
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, eyeY - r * 0.04, r * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.31, eyeY - r * 0.04, r * 0.035, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ─── Blob mascot (right side decoration) ──────────────────────────────────────
function drawBlobMascot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  colors: string[],
  address: string
) {
  const clean = address.replace("0x", "").padEnd(64, "0");
  const seed = (i: number) => parseInt(clean.slice(i * 2 + 20, i * 2 + 22) || "80", 16) / 255;

  ctx.save();
  ctx.globalAlpha = 0.75;

  // Body
  const r = 68;
  ctx.beginPath();
  const pts = 10;
  for (let i = 0; i < pts; i++) {
    const angle = (i / pts) * Math.PI * 2 - Math.PI / 2;
    const br = r * (0.78 + seed(i) * 0.3);
    const x = cx + Math.cos(angle) * br;
    const y = cy + Math.sin(angle) * br;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const mascotGrad = ctx.createRadialGradient(cx - 12, cy - 16, 0, cx, cy, r * 1.2);
  mascotGrad.addColorStop(0, colors[2]);
  mascotGrad.addColorStop(0.5, colors[0]);
  mascotGrad.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = mascotGrad;
  ctx.fill();

  // Arms (holding card)
  ctx.strokeStyle = colors[1];
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  // Left arm
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.7, cy + 10);
  ctx.quadraticCurveTo(cx - r * 1.1, cy + 30, cx - r * 0.85, cy + r * 0.75);
  ctx.stroke();
  // Right arm
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.7, cy + 10);
  ctx.quadraticCurveTo(cx + r * 1.1, cy + 30, cx + r * 0.85, cy + r * 0.75);
  ctx.stroke();

  // Mini card held by mascot
  ctx.fillStyle = "rgba(20,20,30,0.9)";
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.5;
  ctx.save();
  ctx.translate(cx, cy + r * 0.6);
  ctx.rotate(-0.15);
  ctx.beginPath();
  ctx.roundRect(-28, -16, 56, 36, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors[0];
  ctx.font = "bold 8px Courier New";
  ctx.textAlign = "center";
  ctx.globalAlpha = 1;
  ctx.fillText("BLOBCARD", 0, -2);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "7px Courier New";
  ctx.fillText("S1", 0, 10);
  ctx.restore();

  // Face
  ctx.globalAlpha = 0.75;
  const eyeY = cy - r * 0.18;
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.beginPath();
  ctx.arc(cx - r * 0.22, eyeY, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.22, eyeY, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(cx - r * 0.19, eyeY - 2, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.25, eyeY - 2, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Smile
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.05, 14, 0.2, Math.PI - 0.2);
  ctx.stroke();

  ctx.restore();
}

// ─── LocalStorage helpers ──────────────────────────────────────────────────────
const LS_KEY = "blobcard_mints";

function getMintRecord(address: string): MintRecord | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const records: MintRecord[] = JSON.parse(raw);
    return records.find(r => r.address === address) || null;
  } catch {
    return null;
  }
}

function saveMintRecord(record: MintRecord) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const records: MintRecord[] = raw ? JSON.parse(raw) : [];
    const filtered = records.filter(r => r.address !== record.address);
    localStorage.setItem(LS_KEY, JSON.stringify([...filtered, record]));
  } catch {}
}

// ─── Component ─────────────────────────────────────────────────────────────────
export default function BlobCardClient() {
  const { account, connect, wallets, connected, disconnect, signAndSubmitTransaction } = useWallet();
  const walletAddress = account?.address?.toString() ?? "";

  const [theme, setTheme] = useState<Theme>("abyss");
  const [mintRecord, setMintRecord] = useState<MintRecord | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintStatus, setMintStatus] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [showAtmoDropdown, setShowAtmoDropdown] = useState(false);

  const t = THEMES[theme];

  // Load mint record when wallet connects
  useEffect(() => {
    if (walletAddress) {
      setMintRecord(getMintRecord(walletAddress));
    }
  }, [walletAddress]);

  // Render card preview
  const renderCard = useCallback(() => {
    const canvas = previewRef.current;
    if (!canvas || !walletAddress) return;
    drawCard(canvas, walletAddress, t, 1);
  }, [walletAddress, t]);

  useEffect(() => {
    renderCard();
  }, [renderCard]);

  // Mint = upload PNG to Shelby via wallet adapter
  async function handleMint() {
    if (!connected || !walletAddress || !account) return;
    if (mintRecord) return;
    setMinting(true);
    setMintStatus("Generating card...");
    try {
      // Render hi-res card (no placeholders)
      const hiResCanvas = document.createElement("canvas");
      drawCard(hiResCanvas, walletAddress, t, 2, false);
      compositeDrawing(hiResCanvas);
      const blob = await new Promise<Blob>((res, rej) =>
        hiResCanvas.toBlob(b => b ? res(b) : rej(new Error("Canvas to blob failed")), "image/png")
      );

      setMintStatus("Uploading to Shelby...");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const blobName = `blobcard-s1-${walletAddress.slice(0, 10)}.png`;
      const expiryMicros = (Date.now() + 365 * 24 * 60 * 60 * 1000) * 1000;
      const accountAddress = AccountAddress.from(walletAddress);

      // 1. Generate erasure-coding commitments
      const provider = await createDefaultErasureCodingProvider();
      const commitments = await generateCommitments(provider, bytes);
      const chunksetSize = provider.config.chunkSizeBytes * provider.config.erasure_k;

      // 2. Build on-chain registration payload
      const payload = ShelbyBlobClient.createRegisterBlobPayload({
        account: accountAddress,
        blobName,
        blobSize: bytes.length,
        blobMerkleRoot: commitments.blob_merkle_root,
        numChunksets: expectedTotalChunksets(bytes.length, chunksetSize),
        expirationMicros: expiryMicros,
        encoding: provider.config.enumIndex,
      });

      // 3. Submit via Petra wallet adapter
      setMintStatus("Approve in wallet...");
      const result = await signAndSubmitTransaction({ data: payload });

      // 4. Wait for on-chain confirmation
      setMintStatus("Confirming transaction...");
      await (shelbyClient as any).coordination.aptos.waitForTransaction({
        transactionHash: result.hash,
      });

      // 5. Upload blob data to storage nodes
      setMintStatus("Uploading data...");
      await (shelbyClient as any).rpc.putBlob({
        account: accountAddress,
        blobName,
        blobData: bytes,
      });

      const record: MintRecord = { address: walletAddress, blobName, mintedAt: Date.now(), theme };
      saveMintRecord(record);
      setMintRecord(record);
      setMintStatus("Minted!");
      setTimeout(() => setMintStatus(""), 3000);
    } catch (err: any) {
      setMintStatus(`Error: ${err?.message || "Mint failed"}`);
      setTimeout(() => setMintStatus(""), 6000);
    } finally {
      setMinting(false);
    }
  }

  function compositeDrawing(targetCanvas: HTMLCanvasElement) {
    const dc = drawingRef.current;
    if (!dc || dc.width === 0 || dc.height === 0) return;
    const ctx = targetCanvas.getContext("2d")!;
    // Reset any transform left by drawCard (e.g. scale(2,2) for hi-res)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(dc, 0, 0, targetCanvas.width, targetCanvas.height);
    ctx.restore();
  }

  function handleDownload() {
    if (!walletAddress) return;
    const hiResCanvas = document.createElement("canvas");
    drawCard(hiResCanvas, walletAddress, t, 2, false);
    compositeDrawing(hiResCanvas);
    const a = document.createElement("a");
    a.href = hiResCanvas.toDataURL("image/png");
    a.download = `blobcard-s1-${walletAddress.slice(0, 10)}.png`;
    a.click();
  }

  function getDrawPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function onDrawStart(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    isDrawingRef.current = true;
    const canvas = drawingRef.current;
    if (!canvas) return;
    const pt = "touches" in e
      ? getDrawPoint(canvas, e.touches[0])
      : getDrawPoint(canvas, e.nativeEvent as MouseEvent);
    lastPointRef.current = pt;
  }

  // Card-space zone coordinates (matches drawCard at scale=1, 760×420)
  const DRAW_ZONES = [
    { x: 36,  y: 162, w: 688, h: 170, r: 8 }, // main drawing area
    { x: 532, y: 358, w: 190, h: 46,  r: 4 }, // signature area
  ] as const;

  function onDrawMove(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const canvas = drawingRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const pt = "touches" in e
      ? getDrawPoint(canvas, e.touches[0])
      : getDrawPoint(canvas, e.nativeEvent as MouseEvent);
    if (lastPointRef.current) {
      ctx.save();
      // Clip to allowed drawing zones only
      ctx.beginPath();
      for (const z of DRAW_ZONES) {
        ctx.roundRect(z.x, z.y, z.w, z.h, z.r);
      }
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
    lastPointRef.current = pt;
  }

  function onDrawEnd() {
    isDrawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearDrawing() {
    const canvas = drawingRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ─── Styles ────────────────────────────────────────────────────────────────
  const sidebar = { width: "190px", minHeight: "100vh", background: "#111", borderRight: "1px solid #1f1f1f", display: "flex", flexDirection: "column", flexShrink: 0, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50 } as const;
  const navItem = (active: boolean) => ({ display: "flex", alignItems: "center", gap: "10px", padding: "9px 16px", borderRadius: "8px", margin: "2px 10px", cursor: "pointer", fontSize: "14px", color: active ? "#39FF14" : "#aaa", background: active ? "rgba(57,255,20,0.1)" : "transparent", fontWeight: active ? 600 : 400 } as const);
  const NavIcon = ({ d }: { d: string }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );

  return (
    <div style={{ display: "flex", background: "#0d0d0d", minHeight: "100vh" }}>

      {/* ── Sidebar ── */}
      <aside style={sidebar}>
        <div style={{ padding: "16px 14px 14px", borderBottom: "1px solid #1f1f1f" }}>
          <a href="/" style={{ textDecoration: "none" }}>
            <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "14px", color: "#39FF14", textShadow: "0 0 8px rgba(57,255,20,0.6)", letterSpacing: "1px" }}>BLOBSCAN</div>
            <div style={{ fontSize: "10px", color: "#666", marginTop: "8px" }}>Shelby Network</div>
          </a>
        </div>
        <nav style={{ padding: "10px 0", flex: 1 }}>
          {[
            { label: "Home", href: "/", icon: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", active: false },
            { label: "Upload", href: "/upload", icon: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12", active: false },
            { label: "BlobCard", href: "/blobcard", icon: "M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z", active: true },
            { label: "Explorer ↗", href: "https://explorer.shelby.xyz/shelbynet", icon: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3", active: false },
          ].map(item => (
            <a key={item.label} href={item.href} target={item.label.includes("↗") ? "_blank" : undefined} style={{ textDecoration: "none" }}>
              <div style={navItem(item.active)}>
                <NavIcon d={item.icon} />
                {item.label}
              </div>
            </a>
          ))}
        </nav>
        <div style={{ padding: "12px 16px", borderTop: "1px solid #1f1f1f", fontSize: "10px", color: "#666" }}>
          by <a href="https://twitter.com/solscammer" target="_blank" style={{ color: "#666", textDecoration: "none" }}>@solscammer</a>
        </div>
      </aside>

      {/* ── Wallet fixed top-right ── */}
      <div style={{ position: "fixed", top: "12px", right: "24px", zIndex: 100, display: "flex", alignItems: "center", gap: "8px" }}>
        {connected ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "5px 12px", fontSize: "12px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#39FF14", display: "inline-block", animation: "pulse-green 2s infinite" }} />
              <span style={{ color: "#aaa" }}>{walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</span>
            </div>
            <button onClick={() => disconnect()} style={{ background: "transparent", border: "1px solid #333", borderRadius: "8px", padding: "5px 10px", color: "#aaa", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>Disconnect</button>
          </>
        ) : (
          <>
            {wallets.filter(w => w.name === "Petra").map(w => (
              <button key={w.name} onClick={() => connect(w.name)} style={{ background: "#39FF14", color: "#0a0a0a", border: "none", borderRadius: "8px", padding: "5px 14px", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Connect Petra</button>
            ))}
            {wallets.filter(w => w.name === "Petra").length === 0 && (
              <a href="https://petra.app" target="_blank" style={{ background: "transparent", border: "1px solid #333", borderRadius: "8px", padding: "5px 12px", color: "#aaa", fontSize: "12px", textDecoration: "none" }}>Install Petra</a>
            )}
          </>
        )}
      </div>

      {/* ── Main content ── */}
      <main style={{ marginLeft: "190px", minHeight: "100vh", flex: 1, width: "calc(100% - 190px)", padding: "40px 32px 80px" }}>

        {/* Title */}
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "clamp(18px, 3vw, 30px)", color: "#39FF14", textShadow: "0 0 10px rgba(57,255,20,0.5)", letterSpacing: "2px", marginBottom: "10px" }}>BLOBCARD</div>
          <p style={{ color: "#555", fontSize: "12px", margin: 0 }}>Shelby Network · Season 1 · Genesis Edition</p>
        </div>

        {!connected ? (
          /* Not connected */
          <div style={{ maxWidth: "500px", margin: "0 auto", background: "#161616", border: "1px solid #222", borderRadius: "16px", padding: "40px", textAlign: "center" }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>✦</div>
            <div style={{ color: "#e5e5e5", fontSize: "16px", marginBottom: "8px", fontWeight: 600 }}>Connect your wallet</div>
            <p style={{ color: "#666", fontSize: "13px", marginBottom: "24px" }}>Connect Petra to preview and mint your BlobCard. Each address can mint one card per season.</p>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "8px", justifyContent: "center" }}>
              {wallets.filter(w => w.name === "Petra").map(w => (
                <button key={w.name} onClick={() => connect(w.name)} style={{ background: "#39FF14", color: "#0a0a0a", border: "none", borderRadius: "8px", padding: "10px 24px", fontSize: "14px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Connect Petra</button>
              ))}
              {wallets.filter(w => w.name === "Petra").length === 0 && (
                <a href="https://petra.app" target="_blank" style={{ color: "#39FF14", fontSize: "13px" }}>Install Petra Wallet</a>
              )}
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: "900px", margin: "0 auto" }}>

            {/* Already minted banner */}
            {mintRecord && (
              <div style={{ background: "rgba(57,255,20,0.08)", border: "1px solid rgba(57,255,20,0.25)", borderRadius: "10px", padding: "12px 18px", marginBottom: "24px", display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ color: "#39FF14", fontSize: "18px" }}>✦</span>
                <div>
                  <div style={{ color: "#39FF14", fontSize: "13px", fontWeight: 600 }}>BlobCard minted!</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "2px" }}>
                    Stored on Shelby · {new Date(mintRecord.mintedAt).toLocaleString()} · {mintRecord.blobName}
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "28px", flexWrap: "wrap" as const }}>

              {/* Left: controls */}
              <div style={{ flex: "0 0 220px", display: "flex", flexDirection: "column", gap: "16px" }}>

                {/* Theme selector – dropdown */}
                <div style={{ background: "#161616", border: "1px solid #222", borderRadius: "12px", padding: "18px", position: "relative" as const }}>
                  <div style={{ fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "12px" }}>ATMOSPHERE</div>
                  <button
                    onClick={() => !mintRecord && setShowAtmoDropdown(v => !v)}
                    disabled={!!mintRecord}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", background: "rgba(57,255,20,0.06)",
                      border: "1px solid rgba(57,255,20,0.25)", borderRadius: "8px",
                      padding: "9px 12px", color: "#e5e5e5", fontSize: "13px",
                      cursor: mintRecord ? "default" : "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: t.accent, display: "inline-block", boxShadow: `0 0 6px ${t.accent}` }} />
                      {t.label}
                    </span>
                    <span style={{ fontSize: "10px", color: "#555" }}>{showAtmoDropdown ? "▲" : "▼"}</span>
                  </button>
                  {showAtmoDropdown && !mintRecord && (
                    <div style={{ position: "absolute" as const, top: "calc(100% - 6px)", left: "18px", right: "18px", background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: "8px", zIndex: 20, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
                      {(Object.keys(THEMES) as Theme[]).map(k => (
                        <button
                          key={k}
                          onClick={() => { setTheme(k); setShowAtmoDropdown(false); }}
                          style={{
                            display: "flex", alignItems: "center", gap: "10px",
                            width: "100%", background: theme === k ? "rgba(57,255,20,0.08)" : "transparent",
                            border: "none", padding: "10px 14px",
                            color: theme === k ? "#39FF14" : "#aaa", fontSize: "13px",
                            cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const,
                            borderBottom: "1px solid #222",
                          }}
                        >
                          <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: THEMES[k].accent, display: "inline-block", flexShrink: 0, boxShadow: theme === k ? `0 0 6px ${THEMES[k].accent}` : "none" }} />
                          {THEMES[k].label}
                        </button>
                      ))}
                    </div>
                  )}
                  {mintRecord && (
                    <div style={{ fontSize: "10px", color: "#444", marginTop: "8px" }}>Theme locked after mint</div>
                  )}
                </div>

                {/* Card info */}
                <div style={{ background: "#161616", border: "1px solid #222", borderRadius: "12px", padding: "18px" }}>
                  <div style={{ fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "12px" }}>CARD INFO</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {[
                      { label: "Season", value: "S1 · Genesis" },
                      { label: "Rarity", value: "Unique" },
                      { label: "Network", value: "Shelbynet" },
                      { label: "ID", value: addrToId(walletAddress) },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "#555", fontSize: "11px" }}>{label}</span>
                        <span style={{ color: "#aaa", fontSize: "11px", fontFamily: "monospace" }}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right: card preview + actions */}
              <div style={{ flex: 1, minWidth: "320px" }}>

                {/* Card preview + drawing overlay */}
                <div style={{ marginBottom: "8px", borderRadius: "16px", overflow: "hidden", border: "1px solid #1f1f1f", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", position: "relative" as const }}>
                  <canvas
                    ref={previewRef}
                    style={{ display: "block", width: "100%", height: "auto" }}
                  />
                  <canvas
                    ref={drawingRef}
                    width={760}
                    height={420}
                    style={{ position: "absolute" as const, inset: 0, width: "100%", height: "100%", cursor: "crosshair", touchAction: "none" }}
                    onMouseDown={onDrawStart}
                    onMouseMove={onDrawMove}
                    onMouseUp={onDrawEnd}
                    onMouseLeave={onDrawEnd}
                    onTouchStart={(e) => { e.preventDefault(); onDrawStart(e); }}
                    onTouchMove={(e) => { e.preventDefault(); onDrawMove(e); }}
                    onTouchEnd={onDrawEnd}
                  />
                </div>

                {/* Drawing toolbar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", padding: "6px 10px", background: "#111", border: "1px solid #1f1f1f", borderRadius: "8px" }}>
                  <span style={{ fontSize: "11px", color: "#444", fontFamily: "monospace" }}>✏ Draw on the card with your pointer</span>
                  <button
                    onClick={clearDrawing}
                    style={{ background: "transparent", border: "1px solid #333", borderRadius: "6px", padding: "4px 10px", color: "#888", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Clear
                  </button>
                </div>

                {/* Action buttons */}
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" as const }}>
                  {!mintRecord ? (
                    <button
                      onClick={handleMint}
                      disabled={minting}
                      style={{
                        flex: 1, background: minting ? "#1a1a1a" : "#39FF14",
                        color: minting ? "#555" : "#0a0a0a",
                        border: "none", borderRadius: "10px",
                        padding: "14px 24px", fontSize: "14px",
                        fontWeight: 700, cursor: minting ? "not-allowed" : "pointer",
                        fontFamily: "'Courier New', monospace", letterSpacing: "1px",
                        transition: "all 0.2s",
                      }}
                    >
                      {minting ? "MINTING…" : "MINT BLOBCARD"}
                    </button>
                  ) : (
                    <div style={{ flex: 1, background: "rgba(57,255,20,0.05)", border: "1px solid rgba(57,255,20,0.2)", borderRadius: "10px", padding: "14px 24px", fontSize: "13px", color: "#39FF14", fontFamily: "monospace", textAlign: "center" as const }}>
                      ✦ MINTED · S1
                    </div>
                  )}

                  <button
                    onClick={handleDownload}
                    style={{ background: "transparent", border: "1px solid #333", borderRadius: "10px", padding: "14px 20px", fontSize: "13px", color: "#aaa", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" as const }}
                  >
                    Download PNG
                  </button>
                </div>

                {/* Status message */}
                {mintStatus && (
                  <div style={{ marginTop: "12px", padding: "10px 14px", background: mintStatus.startsWith("Error") ? "rgba(248,113,113,0.1)" : "rgba(57,255,20,0.08)", border: `1px solid ${mintStatus.startsWith("Error") ? "rgba(248,113,113,0.3)" : "rgba(57,255,20,0.25)"}`, borderRadius: "8px", fontSize: "12px", color: mintStatus.startsWith("Error") ? "#f87171" : "#39FF14" }}>
                    {mintStatus}
                  </div>
                )}

                {/* One-mint notice */}
                {!mintRecord && (
                  <div style={{ marginTop: "14px", fontSize: "11px", color: "#444", lineHeight: 1.6 }}>
                    Each wallet address can mint <strong style={{ color: "#555" }}>one BlobCard per season</strong>. Once minted, your card is stored permanently on the Shelby network and cannot be changed.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
