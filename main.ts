import fs from 'node:fs';
import process from 'node:process';

// Configuration and environment
const ENV_URL = process.env.MAKEFUN_ENV_URL || 'http://127.0.0.1:8080';
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE;
const OBSERVE_POLL_INTERVAL_MS = 50;
const RETRY_BACKOFF_MS = 200;

if (PROMPT_FILE && fs.existsSync(PROMPT_FILE)) {
  try {
    const brief = fs.readFileSync(PROMPT_FILE, 'utf-8');
    console.log(`[WerewolfAgent] Loaded prompt rules (${brief.length} chars)`);
  } catch (err) {
    console.warn(`[WerewolfAgent] Warning reading prompt file:`, err);
  }
}

// Interfaces matching make.fun werewolf environment schema
interface PlayerRef {
  seat: number;
  name?: string;
  role?: string;
  alive?: boolean;
}

interface YouInfo {
  seat: number;
  name: string;
  role: string;
  alive: boolean;
  partner?: {
    seat: number;
    name: string;
    alive: boolean;
  } | null;
}

interface SeerResult {
  night: number;
  seat: number;
  werewolf: boolean;
}

interface WolfVote {
  night: number;
  seat: number;
  target: number | null;
}

interface LogEntry {
  day?: number;
  night?: number;
  kind: string; // 'speech' | 'vote' | 'dawn' | 'exile' | 'night_kill' | etc.
  seat?: number;
  target?: number | null;
  text?: string;
  [key: string]: any;
}

interface GameView {
  day?: number;
  night?: number;
  you: YouInfo;
  players?: PlayerRef[];
  seerResults?: SeerResult[] | null;
  wolfVotes?: WolfVote[] | null;
  log?: LogEntry[];
  [key: string]: any;
}

interface PendingDecision {
  game: number;
  decision: 'speak' | 'vote' | 'kill' | 'protect' | 'inspect' | string;
  options?: number[];
  max_chars?: number;
  view: GameView;
  [key: string]: any;
}

interface ObserveResponse {
  games?: any[];
  finished?: any[];
  done?: boolean;
  pending?: PendingDecision[];
}

// Helpers
function getDeadSeatsFromLog(log: LogEntry[] | undefined): Set<number> {
  const dead = new Set<number>();
  if (!Array.isArray(log)) return dead;
  for (const entry of log) {
    if (
      entry.kind === 'exile' ||
      entry.kind === 'death' ||
      entry.kind === 'kill' ||
      entry.kind === 'night_kill' ||
      entry.kind === 'eliminated'
    ) {
      if (entry.seat !== undefined && entry.seat !== null) {
        dead.add(entry.seat);
      }
      if (entry.target !== undefined && entry.target !== null) {
        dead.add(entry.target);
      }
    }
  }
  return dead;
}

function isSeatAlive(view: GameView, seat: number): boolean {
  if (Array.isArray(view.players)) {
    const p = view.players.find((pl) => pl.seat === seat);
    if (p && p.alive !== undefined) return Boolean(p.alive);
  }
  const dead = getDeadSeatsFromLog(view.log);
  return !dead.has(seat);
}

function formatSpeech(text: string, maxChars: number = 500): string {
  const singleLine = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, maxChars);
}

// Parse role claims from speeches in log
interface RoleClaim {
  seat: number;
  role: 'seer' | 'doctor';
  text: string;
}

function parseRoleClaimsFromLog(log: LogEntry[] | undefined): RoleClaim[] {
  const claims: RoleClaim[] = [];
  if (!Array.isArray(log)) return claims;

  for (const entry of log) {
    if (entry.kind !== 'speech' || entry.seat === undefined || !entry.text) continue;
    const text = entry.text;
    const lower = text.toLowerCase();

    if (lower.includes('seer') && (lower.includes('i am') || lower.includes("i'm") || lower.includes('claim'))) {
      claims.push({ seat: entry.seat, role: 'seer', text });
    } else if (lower.includes('doctor') && (lower.includes('i am') || lower.includes("i'm") || lower.includes('claim'))) {
      claims.push({ seat: entry.seat, role: 'doctor', text });
    }
  }
  return claims;
}

// Parse Seer's accused werewolf from speech logs
function parseSeerAccusedWerewolf(log: LogEntry[] | undefined): number | undefined {
  if (!Array.isArray(log)) return undefined;

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind !== 'speech' || !entry.text) continue;
    const text = entry.text;
    const lower = text.toLowerCase();

    if (lower.includes('seer') && lower.includes('werewolf')) {
      const m1 = text.match(/inspected\s+seat\s+(\d+)\s+and\s+they\s+are\s+a\s+werewolf/i);
      if (m1) return Number.parseInt(m1[1], 10);
      const m2 = text.match(/seat\s+(\d+)\s+is\s+(?:a\s+)?werewolf/i);
      if (m2) return Number.parseInt(m2[1], 10);
      const m3 = text.match(/vote\s+seat\s+(\d+)/i);
      if (m3) return Number.parseInt(m3[1], 10);
    }
  }
  return undefined;
}

function hasSeerClaimedWerewolfInLog(log: LogEntry[] | undefined): boolean {
  return parseSeerAccusedWerewolf(log) !== undefined;
}

// Tally today's votes from log
function parseTodayVotes(log: LogEntry[] | undefined, currentDay?: number): Map<number, number> {
  const counts = new Map<number, number>();
  if (!Array.isArray(log)) return counts;

  for (const entry of log) {
    if (entry.kind === 'vote' && entry.target !== undefined && entry.target !== null) {
      if (currentDay === undefined || entry.day === undefined || entry.day === currentDay) {
        counts.set(entry.target, (counts.get(entry.target) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// Find partner's vote today
function findPartnerVoteToday(log: LogEntry[] | undefined, partnerSeat: number, currentDay?: number): number | undefined {
  if (!Array.isArray(log)) return undefined;

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'vote' && entry.seat === partnerSeat && entry.target !== undefined && entry.target !== null) {
      if (currentDay === undefined || entry.day === undefined || entry.day === currentDay) {
        return entry.target;
      }
    }
  }
  return undefined;
}

// Decision Engine
function decide(p: PendingDecision): { text?: string; target?: number | null; pass?: boolean } {
  const view = p.view;
  const you = view.you;
  const role = String(you.role || 'villager').toLowerCase();
  const options = Array.isArray(p.options) ? p.options : [];
  const currentDay = view.day;

  switch (p.decision) {
    case 'speak': {
      const maxChars = p.max_chars ?? 500;

      if (role === 'seer') {
        const seerResults = view.seerResults || [];
        const livingWolf = seerResults.find((r) => r.werewolf && isSeatAlive(view, r.seat));
        if (livingWolf) {
          const night = livingWolf.night || 1;
          const speech = `I am the Seer. On night ${night} I inspected seat ${livingWolf.seat} and they are a WEREWOLF. Village, vote seat ${livingWolf.seat} today!`;
          return { text: formatSpeech(speech, maxChars) };
        }

        const innocent = seerResults.find((r) => !r.werewolf);
        if (innocent) {
          const speech = `I am the Seer. Seat ${innocent.seat} is confirmed innocent village.`;
          return { text: formatSpeech(speech, maxChars) };
        }

        const fallback = `I am the Seer. Gathering observations to protect the village tonight.`;
        return { text: formatSpeech(fallback, maxChars) };
      }

      if (role === 'werewolf') {
        const speech = `I am an innocent villager. Let us analyze voting patterns and avoid rushing to unsupported accusations.`;
        return { text: formatSpeech(speech, maxChars) };
      }

      // Doctor / Villager
      if (hasSeerClaimedWerewolfInLog(view.log)) {
        const speech = `I support the Seer claim. Let us unite our votes behind the Seer inspection.`;
        return { text: formatSpeech(speech, maxChars) };
      }

      const speech = `Watching the discussion carefully. Let us protect our town.`;
      return { text: formatSpeech(speech, maxChars) };
    }

    case 'kill': {
      // 1. If partner already voted on this night, choose partner's target so both werewolves 100% agree
      const wolfVotes = view.wolfVotes || [];
      const partnerSeat = you.partner?.seat;
      const partnerVote = wolfVotes.find(
        (v) => (partnerSeat !== undefined ? v.seat === partnerSeat : v.seat !== you.seat) && v.target !== null
      );

      if (partnerVote && partnerVote.target !== null && options.includes(partnerVote.target)) {
        return { target: partnerVote.target };
      }

      // 2. If voting first, check view.log for any player who claimed Seer or Doctor and target them
      const claims = parseRoleClaimsFromLog(view.log);
      const seerClaim = claims.find((c) => c.role === 'seer' && options.includes(c.seat) && isSeatAlive(view, c.seat));
      if (seerClaim) {
        return { target: seerClaim.seat };
      }

      const doctorClaim = claims.find((c) => c.role === 'doctor' && options.includes(c.seat) && isSeatAlive(view, c.seat));
      if (doctorClaim) {
        return { target: doctorClaim.seat };
      }

      // 3. Otherwise pick options[0]
      return { target: options[0] ?? null };
    }

    case 'protect': {
      // Check view.log for any living player who claimed Seer
      const claims = parseRoleClaimsFromLog(view.log);
      const livingSeer = claims.find((c) => c.role === 'seer' && options.includes(c.seat) && isSeatAlive(view, c.seat));
      if (livingSeer) {
        return { target: livingSeer.seat };
      }
      return { target: options[0] ?? null };
    }

    case 'inspect': {
      // Pick first living player in options who has not been inspected yet
      const seerResults = view.seerResults || [];
      const inspectedSeats = new Set(seerResults.map((r) => r.seat));
      for (const opt of options) {
        if (!inspectedSeats.has(opt) && isSeatAlive(view, opt)) {
          return { target: opt };
        }
      }
      return { target: options[0] ?? null };
    }

    case 'vote': {
      if (role === 'seer') {
        const seerResults = view.seerResults || [];
        const livingWolf = seerResults.find((r) => r.werewolf && options.includes(r.seat) && isSeatAlive(view, r.seat));
        if (livingWolf) {
          return { target: livingWolf.seat };
        }
      } else if (role === 'werewolf') {
        const partnerSeat = you.partner?.seat;
        const nonWolfOptions = options.filter(
          (opt) => opt !== you.seat && (partnerSeat === undefined || opt !== partnerSeat)
        );
        const pool = nonWolfOptions.length > 0 ? nonWolfOptions : options;

        // Match partner's vote if already voted today
        if (partnerSeat !== undefined) {
          const partnerTarget = findPartnerVoteToday(view.log, partnerSeat, currentDay);
          if (partnerTarget !== undefined && pool.includes(partnerTarget)) {
            return { target: partnerTarget };
          }
        }

        // Vote for non-wolf with the most votes in view.log
        const voteTally = parseTodayVotes(view.log, currentDay);
        let bestOpt = pool[0] ?? null;
        let maxVotes = -1;
        for (const opt of pool) {
          const count = voteTally.get(opt) ?? 0;
          if (count > maxVotes) {
            maxVotes = count;
            bestOpt = opt;
          }
        }
        return { target: bestOpt };
      } else {
        // Doctor / Villager
        const accusedSeat = parseSeerAccusedWerewolf(view.log);
        if (accusedSeat !== undefined && options.includes(accusedSeat) && isSeatAlive(view, accusedSeat)) {
          return { target: accusedSeat };
        }
      }

      // Plurality vote fallback
      const voteTally = parseTodayVotes(view.log, currentDay);
      let bestOpt = options[0] ?? null;
      let maxVotes = -1;
      for (const opt of options) {
        const count = voteTally.get(opt) ?? 0;
        if (count > maxVotes) {
          maxVotes = count;
          bestOpt = opt;
        }
      }
      return { target: bestOpt };
    }

    default:
      return { target: options[0] ?? null };
  }
}

// Act dispatch handler: sends exact payload expected by make.fun
async function handleDecision(p: PendingDecision): Promise<void> {
  const result = decide(p);

  let payload: any;
  if (p.decision === 'speak') {
    payload = {
      game: p.game,
      decision: 'speak',
      text: result.text ?? 'Looking forward to working together with the village.',
    };
  } else {
    payload = {
      game: p.game,
      decision: p.decision,
      target: result.target !== undefined ? result.target : null,
    };
  }

  try {
    const res = await fetch(`${ENV_URL}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[WerewolfAgent] /act failed HTTP ${res.status} for game ${p.game} (${p.decision}): ${errText}`);
    }
  } catch (err) {
    console.error(`[WerewolfAgent] Network error posting action for game ${p.game}:`, err);
  }
}

// Main competition event loop: 100% deterministic, sequential processing
async function main() {
  console.log(`[WerewolfAgent] Starting deterministic competition loop against ${ENV_URL}`);

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
        // Strictly sequential execution in exact array order for deterministic ordering
        for (const p of pending) {
          await handleDecision(p);
        }
      } else {
        await new Promise((r) => setTimeout(r, OBSERVE_POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error(`[WerewolfAgent] Observe loop error:`, err);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[WerewolfAgent] Fatal loop error:`, err);
  process.exit(1);
});
