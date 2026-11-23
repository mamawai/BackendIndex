import fs from "node:fs";
import path from "node:path";
import { BackendIndexApp } from "@/components/BackendIndexApp";
import type { SnapshotData } from "@/lib/types";

export default function HomePage() {
  const snapshotPath = path.join(process.cwd(), "data", "snapshot.json");
  const raw = fs.readFileSync(snapshotPath, "utf-8");
  const snapshot = JSON.parse(raw) as SnapshotData;

  return <BackendIndexApp snapshot={snapshot} />;
}
