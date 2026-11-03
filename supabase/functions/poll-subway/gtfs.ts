// Minimal GTFS-Realtime protobuf decoder for the fields Headway uses, plus MTA's NYCT extension
// (TripDescriptor field 1001: train_id, is_assigned, direction). Unknown fields are skipped, so new
// fields MTA adds are harmless. Field numbers follow gtfs-realtime.proto and nyct-subway.proto.

export interface StopUpdate {
  stopId: string;
  arrival?: number; // POSIX seconds
  departure?: number;
}

export interface Trip {
  tripId: string;
  routeId: string;
  startDate: string;
  assigned: boolean; // NYCT is_assigned: false = scheduled only, no train dispatched yet
  stops: StopUpdate[];
}

export interface FeedMessage {
  version: string;
  timestamp: number; // header.timestamp, when MTA generated the feed
  entities: number;
  trips: Trip[];
}

class Reader {
  pos: number;
  constructor(private buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start;
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  // Varints up to 2^53 (timestamps are ~2^31), using multiplication instead of 32-bit shifts.
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new Error("varint too long");
  }

  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k % 8];
  }

  sub(): Reader {
    const len = this.varint();
    const start = this.pos;
    if (start + len > this.end) throw new Error("truncated message");
    this.pos += len;
    return new Reader(this.buf, start, start + len);
  }

  string(): string {
    const r = this.sub();
    return decoder.decode(this.buf.subarray(r.pos, r.end));
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: this.sub(); break;
      case 5: this.pos += 4; break;
      default: throw new Error(`unsupported wire type ${wireType}`);
    }
    if (this.pos > this.end) throw new Error("truncated field");
  }
}

const decoder = new TextDecoder();

function stopTimeEvent(r: Reader): number | undefined {
  let time: number | undefined;
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 2 && w === 0) time = r.varint();
    else r.skip(w);
  }
  return time;
}

function stopTimeUpdate(r: Reader): StopUpdate {
  const s: StopUpdate = { stopId: "" };
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 2 && w === 2) s.arrival = stopTimeEvent(r.sub());
    else if (f === 3 && w === 2) s.departure = stopTimeEvent(r.sub());
    else if (f === 4 && w === 2) s.stopId = r.string();
    else r.skip(w);
  }
  return s;
}

function nyctTrip(r: Reader): boolean {
  let assigned = false;
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 2 && w === 0) assigned = r.varint() !== 0;
    else r.skip(w);
  }
  return assigned;
}

function tripDescriptor(r: Reader, t: Trip): void {
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 1 && w === 2) t.tripId = r.string();
    else if (f === 3 && w === 2) t.startDate = r.string();
    else if (f === 5 && w === 2) t.routeId = r.string();
    else if (f === 1001 && w === 2) t.assigned = nyctTrip(r.sub());
    else r.skip(w);
  }
}

function tripUpdate(r: Reader): Trip {
  const t: Trip = { tripId: "", routeId: "", startDate: "", assigned: false, stops: [] };
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 1 && w === 2) tripDescriptor(r.sub(), t);
    else if (f === 2 && w === 2) t.stops.push(stopTimeUpdate(r.sub()));
    else r.skip(w);
  }
  return t;
}

export function decodeFeed(bytes: Uint8Array): FeedMessage {
  const msg: FeedMessage = { version: "", timestamp: 0, entities: 0, trips: [] };
  const r = new Reader(bytes);
  while (!r.done()) {
    const [f, w] = r.key();
    if (f === 1 && w === 2) {
      const h = r.sub();
      while (!h.done()) {
        const [hf, hw] = h.key();
        if (hf === 1 && hw === 2) msg.version = h.string();
        else if (hf === 3 && hw === 0) msg.timestamp = h.varint();
        else h.skip(hw);
      }
    } else if (f === 2 && w === 2) {
      msg.entities++;
      const e = r.sub();
      while (!e.done()) {
        const [ef, ew] = e.key();
        if (ef === 3 && ew === 2) msg.trips.push(tripUpdate(e.sub()));
        else e.skip(ew);
      }
    } else r.skip(w);
  }
  if (!msg.version || !msg.timestamp) throw new Error("not a GTFS-Realtime feed (missing header)");
  return msg;
}
