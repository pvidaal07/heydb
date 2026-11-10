// heydb itself: the real tools on the project (measure), with the fixed
// policy described there. Its answers come from a report already measured,
// so the same run feeds the per-question report and the comparison.
import type { Report } from "../measure.ts";
import type { Answer, Strategy } from "./shared.ts";

export function heydbStrategy(id: string, label: string, report: Report): Strategy {
	const answers = new Map<string, Answer>(
		report.questions.map((result) => [result.id, { steps: result.steps, seen: result.seen, firstRanks: result.firstRanks }]),
	);
	return {
		id,
		label,
		simulated: false,
		run: async (question) => {
			const answer = answers.get(question.id);
			if (answer === undefined) throw new Error(`heydb did not answer question ${question.id}`);
			return answer;
		},
	};
}
