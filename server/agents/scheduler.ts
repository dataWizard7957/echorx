// Scheduler: finds a van stop and slot from Zetaris (van_stops, clinic_slots)
// using walking distance, car/mobility and crew language (POL-WALK, POL-LANG),
// then writes the explanation and the patient's confirmation.
import { z } from "zod";
import { callAgent } from "../providers/nightshift.ts";
import { repo, type Patient, type Slot, type VanStop } from "../data/repository.ts";
import { bookingConfirmation } from "../i18n.ts";
import { trace } from "../trace.ts";
import { loadPrompt } from "./prompts.ts";
import type { Booking, Case } from "./types.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Next date (YYYY-MM-DD) for a weekday, at least 1 day from now so the nurse can review first. */
export function nextDate(weekday: string, from = new Date()): string {
  const target = WEEKDAYS.indexOf(weekday);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 1; i <= 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === target) break;
  }
  return d.toISOString().slice(0, 10);
}

export interface Candidate { stop: VanStop; slot: Slot; distanceMi: number; date: string; score: number; reasons: string[] }

export function rankStops(p: Patient, stops: VanStop[], slots: Slot[], walkingNeeded: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const stop of stops) {
    const distanceMi = Number(milesBetween(p.home_lat, p.home_lng, stop.lat, stop.lng).toFixed(2));
    if (walkingNeeded && distanceMi > 1.5) continue; // POL-WALK hard limit
    if (!walkingNeeded && distanceMi > 8) continue;
    const open = slots.filter((s) => s.stop_id === stop.stop_id && Number(s.capacity) - Number(s.booked) > 0);
    if (!open.length) continue;
    const langs = stop.languages.split(",").map((l) => l.trim());
    const reasons: string[] = [];
    let score = 100 - distanceMi * (walkingNeeded ? 40 : 6);
    if (walkingNeeded && distanceMi <= 0.5) { score += 25; reasons.push(`${distanceMi} mi, within the 0.5 mi walking preference (POL-WALK)`); }
    else reasons.push(`${distanceMi} mi from home`);
    if (p.language !== "en" && langs.includes(p.language)) { score += 30; reasons.push(`crew speaks the patient's language (POL-LANG)`); }
    const date = nextDate(stop.weekday);
    const daysAway = (new Date(`${date}T00:00:00Z`).getTime() - Date.now()) / 86_400_000;
    score -= daysAway * 2;
    out.push({ stop, slot: open[0], distanceMi, date, score: Number(score.toFixed(1)), reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

const Out = z.object({ why: z.string().min(5).max(400), confirmation: z.string().min(5).max(500), confirmation_en: z.string().max(500).optional() });

export async function schedule(c: Case, patient: Patient): Promise<Booking | undefined> {
  const agent = "Scheduler";
  const stops = await repo.getStops(c.id, agent);
  const slots = await repo.getSlots(c.id, agent, stops.map((s) => s.stop_id));
  const noCarClaim = c.claims.some((x) => x.topic === "daily" && /no car|walking/i.test(x.text_en));
  const walkingNeeded = !patient.has_car || noCarClaim || !/none/i.test(patient.mobility);
  const ranked = rankStops(patient, stops, slots, walkingNeeded);
  trace({ caseId: c.id, agent, action: "rank_stops", decision: ranked.slice(0, 3).map((r) => `${r.stop.stop_id} score ${r.score} (${r.distanceMi} mi)`).join(" > ") || "no eligible stop", ok: true });
  const best = ranked[0];
  if (!best) return undefined;
  const langs = best.stop.languages.split(",").map((l) => l.trim());
  const crewSpeaks = c.language !== "en" && langs.includes(c.language);
  const res = await callAgent({
    caseId: c.id,
    agent,
    lane: "fast",
    system: loadPrompt("scheduler"),
    user: JSON.stringify({ language: c.language, patient: { neighborhood: patient.neighborhood, has_car: patient.has_car, mobility: patient.mobility }, chosen: { site: best.stop.site_name, weekday: best.stop.weekday, date: best.date, time: best.slot.start_time, distance_mi: best.distanceMi, reasons: best.reasons }, alternatives: ranked.slice(1, 3).map((r) => ({ site: r.stop.site_name, distance_mi: r.distanceMi, score: r.score })) }),
    schema: Out,
    sample: () => ({
      why: `Chose ${best.stop.site_name}: ${best.reasons.join("; ")}; earliest open slot ${best.slot.slot_id}.`,
      confirmation: bookingConfirmation(c.language, { site: best.stop.site_name, weekday: best.stop.weekday, date: best.date, time: best.slot.start_time, distanceMi: best.distanceMi, crewSpeaks }),
      confirmation_en: bookingConfirmation("en", { site: best.stop.site_name, weekday: best.stop.weekday, date: best.date, time: best.slot.start_time, distanceMi: best.distanceMi, crewSpeaks }),
    }),
    summarize: (o) => o.why.slice(0, 120),
  });
  const confirmationEn = c.language === "en" ? undefined : res.data.confirmation_en || bookingConfirmation("en", { site: best.stop.site_name, weekday: best.stop.weekday, date: best.date, time: best.slot.start_time, distanceMi: best.distanceMi, crewSpeaks });
  return { confirmationEn, stopId: best.stop.stop_id, slotId: best.slot.slot_id, site: best.stop.site_name, area: best.stop.area, van: best.stop.van_id, date: best.date, weekday: best.stop.weekday, time: best.slot.start_time, distanceMi: best.distanceMi, languages: langs, why: res.data.why, confirmation: res.data.confirmation };
}
