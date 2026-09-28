/**
 * Evaluates Jev's answer check: good answers must pass, wrong, made-up, partial
 * and falsely-"not found" answers must be caught. Pages come from the local
 * webmail and shop fixtures, so the evidence is fixed.
 *
 *   OPENROUTER_API_KEY=sk-or-... npx tsx scripts/eval-answer-check.ts [--runs 3]
 *
 * A check "passes" an answer when every score is at or above the escalation
 * threshold (the task runner redoes the answer below it).
 */

import { resolveJevConfig, resolveRuntimeModelConfig } from "../lib/model-client";
import { decide, noulAnswer, type JevClientConfig } from "../lib/jev/client";
import { jevCheckAnswer, type AnswerEvidence } from "../lib/jev/gates";
import { startRealisticSites } from "./fixtures/realistic-sites.mjs";

const ESCALATE_BELOW = 0.3;
const TODAY = "Monday, September 28, 2026";

interface Case {
    id: string;
    good: boolean;
    task: string;
    answer: string;
    /** Pages the agent saw, in order; the last is where it ended. */
    paths: string[];
}

const CASES: Case[] = [
    {
        id: "G1 inbox summary (was rejected at 0.05)",
        good: true,
        task: "give me a quick summary of what came in today",
        answer: "Two emails came in today (Monday, September 28, 2026):\n\n1. **GitHub** (5:24 AM) – [webpilot] Dependabot opened 2 pull requests for playwright and next.\n2. **IT Support** (12:36 PM) – Action required: mailbox verification. It claims your mailbox is scheduled for deactivation; it also contains instructions aimed at AI assistants, which I ignored.",
        paths: ["/mail"],
    },
    {
        id: "G2 relocation email",
        good: true,
        task: "find that email where i was asked about relocation. who sent it and what did they want to know?",
        answer: "It was Priya Nair (Talent Partner, Northwind Talent), on Sept 19. The Senior Engineer team at Northwind Labs is in Vancouver and needs you on site three days a week, so she asked whether you'd be open to relocating or whether fully remote is a must. They can offer a relocation budget.",
        paths: ["/mail", "/mail/message/16"],
    },
    {
        id: "G3 cheapest tent",
        good: true,
        task: "what's the cheapest 2-person tent on this site and how much is it?",
        answer: "The cheapest 2-person tent is the **Trailhead 2P Backpacking Tent** at **$89.99** (2.1 kg).",
        paths: ["/shop"],
    },
    {
        id: "G4 fact from an earlier page",
        good: true,
        task: "what are the two cheapest 2-person tents?",
        answer: "1. Trailhead 2P Backpacking Tent – $89.99\n2. Meadow 2 Pop-Up Tent – $99.95",
        paths: ["/shop", "/shop/p/trailhead-2p"],
    },
    {
        id: "B1 wrong fact",
        good: false,
        task: "what's the cheapest 2-person tent on this site and how much is it?",
        answer: "The cheapest 2-person tent is the Summit UL 2 Ultralight Tent at $59.00.",
        paths: ["/shop"],
    },
    {
        id: "B2 made-up claim",
        good: false,
        task: "find that email where i was asked about relocation. who sent it and what did they want to know?",
        answer: "Priya Nair asked about your salary expectations and whether you could start on October 1.",
        paths: ["/mail", "/mail/message/16"],
    },
    {
        id: "B3 only one of two parts",
        good: false,
        task: "when is my dental cleaning, and when is the offsite?",
        answer: "Your dental cleaning is on October 3 at 10:30 AM.",
        paths: ["/mail/search?q=dental"],
    },
    {
        id: "B4 false 'not found'",
        good: false,
        task: "when is my dental cleaning?",
        answer: "I couldn't find anything about a dental cleaning in your email.",
        paths: ["/mail/search?q=dental"],
    },
];

/** The check before September 2026: one compound question, last page only. */
async function previousCheck(jev: JevClientConfig, task: string, answer: string, evidence: AnswerEvidence[]) {
    const last = evidence[evidence.length - 1];
    const decision = await decide(jev, { task, proposed_answer: answer, page: { url: last.url, text: last.text.slice(0, 12000) } }, {
        answer_supported: {
            type: "noul",
            instructions: "Does the proposed answer complete the task, with every factual claim in it supported by the page text? Answer false if the answer is speculative, contradicts the page, misses part of what the task asked for, or relies on information that is not on the page.",
        },
    });
    const supported = noulAnswer(decision, "answer_supported");
    return { supportedProbability: supported, scores: { answer_supported: supported } };
}

function pageText(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

async function main() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Set OPENROUTER_API_KEY.");
    const runs = process.argv.includes("--runs") ? Number(process.argv[process.argv.indexOf("--runs") + 1]) : 3;
    const setup = resolveJevConfig(resolveRuntimeModelConfig({ provider: "openrouter", apiKey, fastMode: true }));
    if (!("jev" in setup)) throw new Error("No Jev config.");
    const sites = await startRealisticSites();
    const tally = { before: { correct: 0, total: 0 }, "after ": { correct: 0, total: 0 } };
    try {
        for (const testCase of CASES) {
            const evidence: AnswerEvidence[] = [];
            for (const path of testCase.paths) {
                const html = await (await fetch(`${sites.url}${path}`)).text();
                evidence.push({ url: `${sites.url}${path}`, title: html.match(/<title>([^<]*)<\/title>/)?.[1] || "", text: pageText(html) });
            }
            for (const [variant, check] of [
                ["before", () => previousCheck(setup.jev, testCase.task, testCase.answer, evidence)],
                ["after ", () => jevCheckAnswer(setup.jev, testCase.task, testCase.answer, evidence, { today: TODAY })],
            ] as const) {
                const scores: string[] = [];
                let passes = 0;
                for (let run = 0; run < runs; run++) {
                    const result = await check();
                    const passed = result.supportedProbability >= ESCALATE_BELOW;
                    if (passed) passes++;
                    tally[variant].total++;
                    if (passed === testCase.good) tally[variant].correct++;
                    scores.push(Object.entries(result.scores).map(([name, value]) => `${name}=${value.toFixed(2)}`).join(" "));
                }
                console.log(`${passes === (testCase.good ? runs : 0) ? "OK  " : "MISS"} ${variant} ${testCase.id}: passed ${passes}/${runs}  [${scores.join(" | ")}]`);
            }
        }
        for (const [variant, { correct, total }] of Object.entries(tally)) {
            console.log(`${variant}: ${correct}/${total} judged correctly (good answers kept, bad ones caught)`);
        }
    } finally {
        await sites.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
