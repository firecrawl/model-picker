import { z } from "zod";
import { DIFFICULTIES, WORK_KINDS, type Difficulty, type Work } from "./work.ts";

const API_URL = process.env.SUBQ_API_URL ?? "https://api.subq.ai/v1";
const MAX_RETRIES = 3;
// Below this, Snap is torn between tiers, so the work goes one tier up. Not yet tuned on labelled cases.
const MIN_CONFIDENCE = 0.6;

const QUESTIONS = {
  difficulty: {
    type: "choice",
    instructions: "How much reasoning does this piece of software work need?",
    criteria: {
      hard: "Architecture, tricky maths or algorithms, subtle bugs likely, large cross-cutting changes",
      medium: "Substantial feature code or an ordinary fix with a clear approach",
      easy: "Boilerplate, styling, small edits, docs, short answers",
    },
  },
  work: {
    type: "choice",
    instructions: "What kind of work is it mostly?",
    criteria: {
      coding: "Writing or changing code",
      tools: "Multi-step work driving tools, the terminal or a browser",
      vision: "Understanding images or screenshots",
      "long-context": "Reading or reasoning over large files or documents",
      "3d": "Building 3D models, scenes or worlds, e.g. with Three.js, voxels or CAD code",
      general: "Anything else",
    },
  },
};

const answerSchema = z.object({ choice: z.string(), confidence: z.number() });
const responseSchema = z.object({
  answers: z.object({ difficulty: answerSchema, work: answerSchema }),
});

export interface Label {
  /** The tier the work runs at: Snap's answer, or one tier up when Snap was unsure. */
  difficulty: Difficulty;
  work: Work;
  snapDifficulty: Difficulty;
  confidence: number;
}

export const snapEnabled = (): boolean => (process.env.SUBQ_API_KEY ?? "") !== "";

const harder = (difficulty: Difficulty): Difficulty =>
  DIFFICULTIES[Math.max(0, DIFFICULTIES.indexOf(difficulty) - 1)] ?? difficulty;

/** Asks SubQ Snap, a decision model, how hard a piece of work is and what kind it is. */
export async function label(state: string, signal?: AbortSignal): Promise<Label> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_URL}/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.SUBQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "subq-snap-preview", state, questions: QUESTIONS }),
      signal,
    });
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`SubQ returned ${response.status}: ${await response.text()}`);
    const { answers } = responseSchema.parse(await response.json());
    const snapDifficulty = z.enum(DIFFICULTIES).parse(answers.difficulty.choice);
    return {
      difficulty:
        answers.difficulty.confidence < MIN_CONFIDENCE ? harder(snapDifficulty) : snapDifficulty,
      work: z.enum(WORK_KINDS).parse(answers.work.choice),
      snapDifficulty,
      confidence: answers.difficulty.confidence,
    };
  }
}
