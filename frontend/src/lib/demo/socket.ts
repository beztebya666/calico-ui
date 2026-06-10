// Fake WebSocket for the calico-ui demo: /ws/flows streams live flow events
// (type:"flow") sampled from the seed with fresh timestamps, so the live flow
// view animates like a real Calico/Goldmane stream.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDB } from "./db";

type Cb = ((ev: any) => void) | null;

export class DemoWebSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  url: string; readyState = 0; binaryType = "blob";
  onopen: Cb = null; onmessage: Cb = null; onclose: Cb = null; onerror: Cb = null;
  private timer: any = null; private closed = false;
  constructor(url: string) { this.url = String(url); setTimeout(() => this.start(), 0); }
  private start() {
    if (this.closed) return;
    this.readyState = this.OPEN; this.onopen?.({});
    if (!/\/ws\/flows/.test(this.url)) return;
    let ns: string | null = null; try { ns = new URL(this.url, location.origin).searchParams.get("namespace"); } catch { /* */ }
    let pool: any[] = getDB().flows;
    if (ns && ns !== "all" && ns !== "__all__") pool = pool.filter((f) => f.source.namespace === ns || f.destination.namespace === ns);
    if (!pool.length) pool = getDB().flows;
    let i = 0;
    const tick = () => {
      if (this.closed) return;
      const base = pool[i++ % pool.length];
      const t = Math.floor(Date.now() / 1000);
      const flow = { ...base, id: Date.now() + i, startTime: t - 2, endTime: t, bytesIn: Math.round(base.bytesIn * (0.6 + Math.random() * 0.8)), bytesOut: Math.round(base.bytesOut * (0.6 + Math.random() * 0.8)), connections: { ...base.connections, live: Math.round(Math.random() * 5) } };
      this.onmessage?.({ data: JSON.stringify({ type: "flow", data: flow }) });
      this.timer = setTimeout(tick, 800 + Math.random() * 1200);
    };
    this.timer = setTimeout(tick, 400);
  }
  send() { /* client doesn't send */ }
  addEventListener() { /* on* props used */ }
  removeEventListener() { /* */ }
  close() { if (this.closed) return; this.closed = true; this.readyState = this.CLOSED; clearTimeout(this.timer); this.onclose?.({ code: 1000 }); }
}
