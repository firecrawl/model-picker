import { expect, test } from "bun:test";
import { parseLeaderboard } from "../src/minebench.ts";

const MARKDOWN = `| Model | Rating | Confidence | Consistency | Record | Votes |
| --- | --- | --- | --- | --- | --- |
| 1<br>GPT 6 Astra Pro<br>openaiStable | 2,261±16.8<br>\\[2,244, 2,278\\] | 86%<br>SE 9 | 91.8 | W 3841L 671D 311 | 4,833<br>both bad 10 |
| 2NEW<br>Gemini 4 Argon<br>geminiProvisional | 2,247±48.4<br>\\[2,198, 2,295\\] | 59%<br>SE 25 | 96.2 | W 411L 75D 14 | 504<br>both bad 4 |
| 742<br>GPT 5 Nano<br>openaiStable | 593±18.7<br>\\[575, 612\\] | 84%<br>SE 10 | 97.2 | W 541L 6679D 107 | 9,180<br>both bad 1,853 |`;

test("parses MineBench ratings by model name", () => {
  expect(parseLeaderboard(MARKDOWN)).toEqual(
    new Map([
      ["GPT 6 Astra Pro", 2261],
      ["Gemini 4 Argon", 2247],
      ["GPT 5 Nano", 593],
    ]),
  );
});
