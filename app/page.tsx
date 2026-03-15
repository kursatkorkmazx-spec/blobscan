"use client";
import dynamic from "next/dynamic";
const BlobScan = dynamic(() => import("./BlobScanClient"), { ssr: false });
export default function Home() {
  return <BlobScan />;
}
