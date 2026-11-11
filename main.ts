import fs from 'node:fs';
import process from 'node:process';

// Configuration and environment
const ENV_URL = process.env.MAKEFUN_ENV_URL || 'http://127.0.0.1:8080';
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE;
const MAX_CONCURRENCY = 10;
const OBSERVE_POLL_INTERVAL_MS = 100;
const RETRY_BACKOFF_MS = 300;

if (PROMPT_FILE && fs.existsSync(PROMPT_FILE)) {
  try {
    const brief = fs.readFileSync(PROMPT_FILE, 'utf-8');
    console.log(`[WerewolfAgent] Loaded prompt rules (${brief.length} chars)`);
  } catch (err) {
    console.warn(`[WerewolfAgent] Warning reading prompt file:`, err);
  }
}

// Interfaces
interface PlayerInfo {
  seat?: number | string;
  id?: number | string;
  alive?: boolean;
  is_alive?: boolean;
  status?: string;
  role?: string;
  is_werewolf?: boolean;
}

interface GameView {
  seat?: number | string;
  role?: string;
  night?: number;
  day?: number;
  players?: PlayerInfo[];
  aliveSeats?: (number | string)[];
  deadSeats?: (number | string)[];
  log?: any[];
  wolfVotes?: any;
  seerResults?: any;
  partner?: number | string;
  partnerSeat?: number | string;
  werewolves?: (number | string)[];
  wolves?: (number | string)[];
  votes?: any;
  dayVotes?: any;
  [key: string]: any;
}

interface PendingDecision {
  game_id?: string;
  gameId?: string;
  decision_id?: string;
  decisionId?: string;
  type: 'speak' | 'vote' | 'kill' | 'protect' | 'inspect' | string;
  seat?: number | string;
  options?: any[];
  view?: GameView;
  max_chars?: number;
  [key: string]: any;
}

interface ObserveResponse {
  games?: any[];
  finished?: any[];
  done?: boolean;
  pending?: PendingDecision[];
}

interface InspectedPlayer {
  seat: string;
  isWerewolf: boolean;
  night?: number;
}

interface RoleClaim {
  seat: string;
  role: 'seer' | 'doctor' | 'villager' | 'werewolf';
  text: string;
}

// Semaphore for concurrency control
class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENCY);

// Helper functions for inspecting game state
function isPlayerAlive(view: GameView | undefined, seat: string | number): boolean {
  if (!view) return true;
  const sStr = String(seat);

  if (Array.isArray(view.players)) {
    const p = view.players.find((pl) => String(pl.seat ?? pl.id) === sStr);
    if (p) {
      if (p.alive !== undefined) return Boolean(p.alive);
      if (p.is_alive !== undefined) return Boolean(p.is_alive);
      if (p.status !== undefined) return p.status === 'alive';
    }
  }
  if (Array.isArray(view.aliveSeats)) {
    return view.aliveSeats.map(String).includes(sStr);
  }
  if (Array.isArray(view.deadSeats)) {
    return !view.deadSeats.map(String).includes(sStr);
  }
  return true;
}

function findOption(options: any[] | undefined, targetSeat: string | number | undefined): any {
  if (!options || options.length === 0) return undefined;
  if (targetSeat === undefined || targetSeat === null) return options[0];
  const tStr = String(targetSeat);
  const match = options.find((opt) => String(opt) === tStr);
  return match !== undefined ? match : options[0];
}

function parseSeerResults(seerResults: any): InspectedPlayer[] {
  const results: InspectedPlayer[] = [];
  if (!seerResults) return results;

  if (Array.isArray(seerResults)) {
    for (const item of seerResults) {
      if (typeof item === 'object' && item !== null) {
        const seat = item.seat ?? item.target ?? item.inspectedSeat;
        const role = String(item.role ?? item.result ?? '').toLowerCase();
        const isWerewolf = Boolean(
          item.isWerewolf ??
          item.is_werewolf ??
          role.includes('werewolf') ||
          role.includes('wolf')
        );
        const night = item.night;
        if (seat !== undefined) {
          results.push({ seat: String(seat), isWerewolf, night });
        }
      } else if (item !== undefined && item !== null) {
        results.push({ seat: String(item), isWerewolf: false });
      }
    }
  } else if (typeof seerResults === 'object') {
    for (const [seat, val] of Object.entries(seerResults)) {
      if (typeof val === 'object' && val !== null) {
        const role = String((val as any).role ?? (val as any).result ?? '').toLowerCase();
        const isWerewolf = Boolean(
          (val as any).isWerewolf ??
          (val as any).is_werewolf ??
          role.includes('werewolf') ||
          role.includes('wolf')
        );
        const night = (val as any).night;
        results.push({ seat: String(seat), isWerewolf, night });
      } else {
        const s = String(val).toLowerCase();
        const isWerewolf = s.includes('werewolf') || s.includes('wolf') || val === true;
        results.push({ seat: String(seat), isWerewolf });
      }
    }
  }
  return results;
}

function getInspectedSeats(seerResults: any): Set<string> {
  const inspected = new Set<string>();
  const list = parseSeerResults(seerResults);
  for (const item of list) {
    inspected.add(item.seat);
  }
  return inspected;
}

function parseLogClaims(log: any[] | undefined): RoleClaim[] {
  const claims: RoleClaim[] = [];
  if (!Array.isArray(log)) return claims;

  for (const entry of log) {
    let seat: string | number | undefined;
    let text = '';

    if (typeof entry === 'string') {
      text = entry;
      const match = text.match(/(?:Seat|Player)\s*(\d+)[:\s]|\[Seat\s*(\d+)\]|^(\d+)[:\s]/i);
      if (match) {
        seat = match[1] ?? match[2] ?? match[3];
      }
    } else if (typeof entry === 'object' && entry !== null) {
      seat = entry.seat ?? entry.sender ?? entry.player ?? entry.from ?? entry.speaker;
      text = entry.text ?? entry.message ?? entry.content ?? entry.statement ?? '';
    }

    if (!text) continue;
    const lower = text.toLowerCase();

    if (lower.includes('seer') && (lower.includes('i am') || lower.includes("i'm") || lower.includes('claim'))) {
      if (seat !== undefined) {
        claims.push({ seat: String(seat), role: 'seer', text });
      }
    } else if (lower.includes('doctor') && (lower.includes('i am') || lower.includes("i'm") || lower.includes('claim'))) {
      if (seat !== undefined) {
        claims.push({ seat: String(seat), role: 'doctor', text });
      }
    }
  }
  return claims;
}

function extractVoteTargetFromString(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/voted?\s+(?:for\s+)?(?:Seat|Player)?\s*(\d+)/i);
  if (m) return m[1];
  const m2 = text.match(/vote:\s*\d+\s*->\s*(\d+)/i);
  if (m2) return m2[1];
  return undefined;
}

function parseTodayVotes(log: any[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(log)) return counts;

  for (const entry of log) {
    let target: string | undefined;

    if (typeof entry === 'object' && entry !== null) {
      if (entry.type === 'vote' || entry.event === 'vote' || entry.action === 'vote') {
        const t = entry.target ?? entry.vote ?? entry.votedFor;
        if (t !== undefined) target = String(t);
      } else {
        const text = entry.text ?? entry.message ?? '';
        target = extractVoteTargetFromString(text);
      }
    } else if (typeof entry === 'string') {
      target = extractVoteTargetFromString(entry);
    }

    if (target !== undefined) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }

  return counts;
}

function findVoterTargetInLog(log: any[] | undefined, voterSeat: string | number): string | undefined {
  if (!Array.isArray(log)) return undefined;
  const vStr = String(voterSeat);

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (typeof entry === 'object' && entry !== null) {
      const v = entry.voter ?? entry.seat ?? entry.sender;
      if (v !== undefined && String(v) === vStr) {
        const t = entry.target ?? entry.vote ?? entry.votedFor;
        if (t !== undefined) return String(t);
        const text = entry.text ?? entry.message ?? '';
        const target = extractVoteTargetFromString(text);
        if (target !== undefined) return target;
      }
    } else if (typeof entry === 'string') {
      const prefix = entry.match(/(?:Seat|Player)\s*(\d+)[\s:]/i);
      if (prefix && String(prefix[1]) === vStr) {
        const target = extractVoteTargetFromString(entry);
        if (target !== undefined) return target;
      }
    }
  }
  return undefined;
}

function getPartnerSeat(view: GameView, mySeat: string | number): string | undefined {
  const mySeatStr = String(mySeat);
  if (view.partner !== undefined && view.partner !== null && String(view.partner) !== mySeatStr) {
    return String(view.partner);
  }
  if (view.partnerSeat !== undefined && view.partnerSeat !== null && String(view.partnerSeat) !== mySeatStr) {
    return String(view.partnerSeat);
  }
  if (Array.isArray(view.werewolves)) {
    const p = view.werewolves.find((s) => String(s) !== mySeatStr);
    if (p !== undefined) return String(p);
  }
  if (Array.isArray(view.wolves)) {
    const p = view.wolves.find((s) => String(s) !== mySeatStr);
    if (p !== undefined) return String(p);
  }
  if (Array.isArray(view.players)) {
    const wolfPlayer = view.players.find(
      (p) => (p.role === 'werewolf' || p.is_werewolf) && String(p.seat ?? p.id) !== mySeatStr
    );
    if (wolfPlayer) return String(wolfPlayer.seat ?? wolfPlayer.id);
  }
  return undefined;
}

function getPartnerKillVote(wolfVotes: any, mySeat: string | number): any {
  if (!wolfVotes) return undefined;
  const mySeatStr = String(mySeat);

  if (Array.isArray(wolfVotes)) {
    for (const item of wolfVotes) {
      const voter = item?.seat ?? item?.voter ?? item?.from;
      const target = item?.target ?? item?.vote ?? item?.to;
      if (voter !== undefined && String(voter) !== mySeatStr && target !== undefined) {
        return target;
      }
    }
  } else if (typeof wolfVotes === 'object') {
    for (const [voter, target] of Object.entries(wolfVotes)) {
      if (String(voter) !== mySeatStr && target !== undefined && target !== null) {
        return typeof target === 'object' ? (target as any)?.target ?? target : target;
      }
    }
  }
  return undefined;
}

function parseSeerAccusedWerewolf(log: any[] | undefined): string | undefined {
  if (!Array.isArray(log)) return undefined;

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    let text = '';
    if (typeof entry === 'string') {
      text = entry;
    } else if (typeof entry === 'object' && entry !== null) {
      text = entry.text ?? entry.message ?? entry.content ?? '';
    }

    if (!text) continue;
    const lower = text.toLowerCase();

    if (lower.includes('seer') && lower.includes('werewolf')) {
      const m1 = text.match(/inspected\s+seat\s+(\d+)\s+and\s+they\s+are\s+a\s+werewolf/i);
      if (m1) return m1[1];
      const m2 = text.match(/seat\s+(\d+)\s+is\s+(?:a\s+)?werewolf/i);
      if (m2) return m2[1];
      const m3 = text.match(/vote\s+seat\s+(\d+)/i);
      if (m3) return m3[1];
    }
  }
  return undefined;
}

function hasSeerClaimedWerewolfInLog(log: any[] | undefined): boolean {
  return parseSeerAccusedWerewolf(log) !== undefined;
}

function formatSpeech(text: string, maxChars: number = 500): string {
  const singleLine = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, maxChars);
}

// Strategic Decision Engine
function decide(p: PendingDecision): any {
  const view: GameView = p.view || {};
  const mySeat = p.seat ?? view.seat ?? 0;
  const role = String(view.role || 'villager').toLowerCase();
  const options = p.options || [];

  switch (p.type) {
    case 'kill': {
      // Werewolf kill coordination
      const partnerTarget = getPartnerKillVote(view.wolfVotes, mySeat);
      if (partnerTarget !== undefined) {
        const matched = options.find((opt) => String(opt) === String(partnerTarget));
        if (matched !== undefined) return matched;
      }

      // If voting first, check view.log for any player who claimed Seer or Doctor
      const claims = parseLogClaims(view.log);
      const seerClaim = claims.find((c) => c.role === 'seer' && isPlayerAlive(view, c.seat));
      if (seerClaim) {
        const match = options.find((opt) => String(opt) === seerClaim.seat);
        if (match !== undefined) return match;
      }

      const doctorClaim = claims.find((c) => c.role === 'doctor' && isPlayerAlive(view, c.seat));
      if (doctorClaim) {
        const match = options.find((opt) => String(opt) === doctorClaim.seat);
        if (match !== undefined) return match;
      }

      return options[0];
    }

    case 'protect': {
      // Doctor protection
      const claims = parseLogClaims(view.log);
      const livingSeer = claims.find((c) => c.role === 'seer' && isPlayerAlive(view, c.seat));
      if (livingSeer) {
        const match = options.find((opt) => String(opt) === livingSeer.seat);
        if (match !== undefined) return match;
      }
      return options[0];
    }

    case 'inspect': {
      // Seer inspection
      const inspected = getInspectedSeats(view.seerResults);
      for (const opt of options) {
        const optStr = String(opt);
        if (!inspected.has(optStr) && isPlayerAlive(view, optStr)) {
          return opt;
        }
      }
      return options[0];
    }

    case 'speak': {
      const maxChars = p.max_chars ?? 500;
      if (role === 'seer') {
        const inspectedList = parseSeerResults(view.seerResults);
        const livingWolf = inspectedList.find((item) => item.isWerewolf && isPlayerAlive(view, item.seat));
        if (livingWolf) {
          const night = livingWolf.night ?? view.night ?? 1;
          const speech = `I am the Seer. On night ${night} I inspected seat ${livingWolf.seat} and they are a WEREWOLF. Village, vote seat ${livingWolf.seat} today!`;
          return formatSpeech(speech, maxChars);
        }

        const innocent = inspectedList.find((item) => !item.isWerewolf);
        if (innocent) {
          const speech = `I am the Seer. Seat ${innocent.seat} is confirmed innocent village.`;
          return formatSpeech(speech, maxChars);
        }

        const fallback = `I am the Seer. Gathering observations to protect the village tonight.`;
        return formatSpeech(fallback, maxChars);
      }

      if (role === 'werewolf') {
        const speech = `I am an innocent villager. Let us analyze voting patterns and avoid rushing to unsupported accusations.`;
        return formatSpeech(speech, maxChars);
      }

      // Doctor / Villager
      if (hasSeerClaimedWerewolfInLog(view.log)) {
        const speech = `I support the Seer claim. Let us unite our votes behind the Seer inspection.`;
        return formatSpeech(speech, maxChars);
      }

      const speech = `Watching the discussion carefully. Let us protect our town.`;
      return formatSpeech(speech, maxChars);
    }

    case 'vote': {
      // Exile voting
      if (role === 'seer') {
        const inspectedList = parseSeerResults(view.seerResults);
        const livingWolf = inspectedList.find((item) => item.isWerewolf && isPlayerAlive(view, item.seat));
        if (livingWolf) {
          const match = options.find((opt) => String(opt) === livingWolf.seat);
          if (match !== undefined) return match;
        }
      } else if (role === 'werewolf') {
        const partnerSeat = getPartnerSeat(view, mySeat);
        const nonWolfOptions = options.filter(
          (opt) => String(opt) !== String(mySeat) && (partnerSeat === undefined || String(opt) !== partnerSeat)
        );
        const pool = nonWolfOptions.length > 0 ? nonWolfOptions : options;

        // Check if partner already voted today
        if (partnerSeat !== undefined) {
          const partnerTarget =
            findVoterTargetInLog(view.log, partnerSeat) ??
            view.votes?.[partnerSeat] ??
            view.dayVotes?.[partnerSeat];
          if (partnerTarget !== undefined) {
            const partnerTargetStr = String(partnerTarget);
            if (partnerTargetStr !== String(mySeat) && partnerTargetStr !== partnerSeat) {
              const matched = pool.find((opt) => String(opt) === partnerTargetStr);
              if (matched !== undefined) return matched;
            }
          }
        }

        // Vote for non-wolf with most votes in log
        const voteTally = parseTodayVotes(view.log);
        let bestOpt = pool[0];
        let maxVotes = -1;
        for (const opt of pool) {
          const count = voteTally.get(String(opt)) ?? 0;
          if (count > maxVotes) {
            maxVotes = count;
            bestOpt = opt;
          }
        }
        return bestOpt;
      } else {
        // Doctor / Villager
        const accusedSeat = parseSeerAccusedWerewolf(view.log);
        if (accusedSeat !== undefined) {
          const match = options.find((opt) => String(opt) === accusedSeat);
          if (match !== undefined) return match;
        }
      }

      // Plurality vote fallback
      const voteTally = parseTodayVotes(view.log);
      let bestOpt = options[0];
      let maxVotes = -1;
      for (const opt of options) {
        const count = voteTally.get(String(opt)) ?? 0;
        if (count > maxVotes) {
          maxVotes = count;
          bestOpt = opt;
        }
      }
      return bestOpt;
    }

    default:
      return options[0] ?? null;
  }
}

// Act dispatch handler
async function handleDecision(p: PendingDecision): Promise<void> {
  const chosenAction = decide(p);
  const payload = {
    game_id: p.game_id ?? p.gameId,
    decision_id: p.decision_id ?? p.decisionId,
    action: chosenAction,
  };

  try {
    const res = await fetch(`${ENV_URL}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[WerewolfAgent] /act failed HTTP ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.error(`[WerewolfAgent] Network error posting action:`, err);
  }
}

// Main competition event loop
async function main() {
  console.log(`[WerewolfAgent] Starting competition loop against ${ENV_URL}`);

  while (true) {
    try {
      const res = await fetch(`${ENV_URL}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        console.warn(`[WerewolfAgent] /observe status ${res.status}, retrying in ${RETRY_BACKOFF_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }

      const data = (await res.json()) as ObserveResponse;

      if (data.done) {
        console.log(`[WerewolfAgent] Competition completed (done: true). Exiting.`);
        break;
      }

      const pending = data.pending || [];
      if (pending.length > 0) {
        await Promise.all(
          pending.map((item) => semaphore.run(() => handleDecision(item)))
        );
      } else {
        await new Promise((r) => setTimeout(r, OBSERVE_POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error(`[WerewolfAgent] Observe loop error:`, err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[WerewolfAgent] Fatal loop error:`, err);
  process.exit(1);
});
