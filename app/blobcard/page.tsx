"use client";
import dynamic from "next/dynamic";

const BlobCardClient = dynamic(() => import("./BlobCardClient"), { ssr: false });

export default function BlobCardPage() {
  return <BlobCardClient />;
}
