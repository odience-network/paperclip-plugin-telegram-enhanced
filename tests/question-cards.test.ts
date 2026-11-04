import { describe, expect, it } from "vitest";
import {
  agentMarkdownToV2,
  applyTextAnswer,
  buildAnswers,
  cardFromInteraction,
  confirmationFromText,
  isComplete,
  isReminderDue,
  missingRequired,
  parseCardCallback,
  parseCardQuestions,
  parseLegacyAnswerSyntax,
  parseQuestionSetQuestions,
  renderCard,
  renderClosedCard,
  toggleOption,
  type QuestionCard,
} from "../src/question-cards.js";

const context = { agentName: "Ant", issueIdentifier: "XPL-7", issueTitle: "Pick a DB", excerpt: "Two options fit." };
const links = { issueMd: "`XPL\\-7`", issueButton: { text: "Open XPL-7", url: "https://pc.example/XPL/issues/XPL-7" } };

function askInteraction(questions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    issueId: "iss-1",
    companyId: "co-1",
    kind: "ask_user_questions",
    status: "pending",
    payload: { version: 1, title: "Database choice", questions, ...extra },
  };
}

const singleQ = {
  id: "db",
  prompt: "Which database?",
  selectionMode: "single",
  required: true,
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sqlite", label: "SQLite" },
  ],
};

function card(questions: unknown[]): QuestionCard {
  const c = cardFromInteraction(askInteraction(questions), context);
  if (!c) throw new Error("card expected");
  return c;
}

describe("cardFromInteraction", () => {
  it("ignores kinds it does not render", () => {
    expect(cardFromInteraction({ ...askInteraction([singleQ]), kind: "suggest_tasks" }, context)).toBeNull();
  });

  it("parses confirmations with labels and defaults", () => {
    const c = cardFromInteraction(
      {
        id: "int-2",
        issueId: "iss-1",
        companyId: "co-1",
        kind: "request_confirmation",
        payload: { prompt: "Deploy to prod?", acceptLabel: "Deploy" },
      },
      context,
    );
    expect(c?.confirm).toEqual({ prompt: "Deploy to prod?", acceptLabel: "Deploy", rejectLabel: "Reject" });
  });

  it("labels an unlabeled free-text option", () => {
    const c = card([{ ...singleQ, options: [...singleQ.options, { id: "other", freeText: true }] }]);
    expect(c.questions[0]!.options[2]).toEqual({ id: "other", label: "Other (type answer)", freeText: true });
  });
});

describe("questionSet (paperclip.question_set.v1)", () => {
  function questionSetInteraction(questions: unknown[]) {
    return {
      id: "int-qs",
      issueId: "iss-1",
      companyId: "co-1",
      kind: "ask_user_questions",
      status: "pending",
      payload: {
        version: 1,
        title: "Hire responsibility",
        // A real interaction carries both: the server generates `questions`
        // for storage/answer compatibility alongside the authored `questionSet`.
        questionSet: { schema: "paperclip.question_set.v1", questions },
        questions: [{ id: "legacy-shadow", prompt: "legacy shadow", selectionMode: "single", required: true, options: [] }],
      },
    };
  }

  it("is read before the legacy `questions[]` shadow copy", () => {
    const parsed = parseQuestionSetQuestions({
      questionSet: {
        schema: "paperclip.question_set.v1",
        questions: [{ id: "responsibility", prompt: "What should the new agent be responsible for?", required: true, answerMode: "text" }],
      },
    });
    expect(parsed).toEqual([
      { id: "responsibility", prompt: "What should the new agent be responsible for?", selectionMode: "single", required: true, options: [] },
    ]);
  });

  it("returns null (so the caller falls back to legacy) when questionSet is absent", () => {
    expect(parseQuestionSetQuestions({ questions: [singleQ] })).toBeNull();
  });

  it("renders and answers a text question with no options", () => {
    const c = cardFromInteraction(
      questionSetInteraction([{ id: "responsibility", prompt: "What should the new agent be responsible for?", required: true, answerMode: "text" }]),
      context,
    )!;
    expect(c.questions).toEqual([
      { id: "responsibility", prompt: "What should the new agent be responsible for?", selectionMode: "single", required: true, options: [] },
    ]);
    const { text, keyboard } = renderCard(c, links);
    expect(text).toContain("Reply to this message with your answer\\.");
    expect(keyboard.map((row) => row[0]!.text)).toEqual(["Open XPL-7"]); // no option buttons - only the issue link

    expect(applyTextAnswer(c, "Research and competitor analysis")).toBe("responsibility");
    expect(isComplete(c)).toBe(true);
    expect(buildAnswers(c)).toEqual([
      { questionId: "responsibility", optionIds: [], otherText: "Research and competitor analysis" },
    ]);
  });

  it("maps single_select and multi_select to the right selection mode and keeps options", () => {
    const c = cardFromInteraction(
      questionSetInteraction([
        {
          id: "responsibility",
          prompt: "What should the new agent be responsible for?",
          answerMode: "single_select",
          required: true,
          options: [
            { id: "research", label: "Research", description: "Find and summarize information." },
            { id: "writing", label: "Writing", description: "Draft and edit content." },
          ],
        },
        {
          id: "tools",
          prompt: "Which tools?",
          answerMode: "multi_select",
          required: false,
          options: [{ id: "slack", label: "Slack" }, { id: "github", label: "GitHub" }],
        },
      ]),
      context,
    )!;
    expect(c.questions[0]).toEqual({
      id: "responsibility",
      prompt: "What should the new agent be responsible for?",
      selectionMode: "single",
      required: true,
      options: [{ id: "research", label: "Research" }, { id: "writing", label: "Writing" }],
    });
    expect(c.questions[1]!.selectionMode).toBe("multi");
    expect(c.questions[1]!.required).toBe(false);
  });

  it("never drops a question or an option for a card with more than four questions", () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      prompt: `Question number ${i + 1}?`,
      answerMode: "single_select",
      required: true,
      options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }, { id: "c", label: "Option C" }],
    }));
    const c = cardFromInteraction(questionSetInteraction(questions), context)!;
    expect(c.questions).toHaveLength(6);
    const { keyboard } = renderCard(c, links);
    // 6 questions x 3 options each, plus Send, plus the issue link.
    expect(keyboard).toHaveLength(6 * 3 + 2);
    for (let qi = 0; qi < 6; qi++) {
      for (let oi = 0; oi < 3; oi++) {
        expect(keyboard.some((row) => row[0]!.callback_data === `qc:o:${qi}:${oi}`)).toBe(true);
      }
    }
  });
});

describe("answering", () => {
  it("one tap answers a lone single-select question", () => {
    const c = card([singleQ]);
    expect(toggleOption(c, 0, 1)).toEqual({ kind: "updated", submit: true });
    expect(buildAnswers(c)).toEqual([{ questionId: "db", optionIds: ["sqlite"] }]);
  });

  it("multi select toggles and waits for Send", () => {
    const c = card([{ ...singleQ, selectionMode: "multi" }]);
    expect(toggleOption(c, 0, 0)).toEqual({ kind: "updated", submit: false });
    toggleOption(c, 0, 1);
    toggleOption(c, 0, 0);
    expect(buildAnswers(c)).toEqual([{ questionId: "db", optionIds: ["sqlite"] }]);
  });

  it("several questions need every required answer before completing", () => {
    const c = card([singleQ, { ...singleQ, id: "host", prompt: "Where?", required: true }]);
    expect(toggleOption(c, 0, 0)).toEqual({ kind: "updated", submit: false });
    expect(missingRequired(c)).toEqual(["host"]);
    expect(isComplete(c)).toBe(false);
    toggleOption(c, 1, 1);
    expect(isComplete(c)).toBe(true);
  });

  it("a free-text option asks for a reply and the reply lands on it", () => {
    const c = card([{ ...singleQ, options: [...singleQ.options, { id: "other", label: "Other", freeText: true }] }]);
    expect(toggleOption(c, 0, 2)).toEqual({ kind: "needs_text", questionId: "db" });
    expect(applyTextAnswer(c, "  MariaDB  ", "db")).toBe("db");
    expect(buildAnswers(c)).toEqual([{ questionId: "db", optionIds: ["other"], otherText: "MariaDB" }]);
  });

  it("a plain reply answers the first open question and replaces a tapped single choice", () => {
    const c = card([singleQ]);
    toggleOption(c, 0, 0);
    expect(applyTextAnswer(c, "Whatever is cheapest")).toBe("db");
    expect(buildAnswers(c)).toEqual([{ questionId: "db", optionIds: [], otherText: "Whatever is cheapest" }]);
    expect(isComplete(c)).toBe(true);
  });

  it("ignores empty replies and invalid buttons", () => {
    const c = card([singleQ]);
    expect(applyTextAnswer(c, "   ")).toBeNull();
    expect(toggleOption(c, 3, 0)).toEqual({ kind: "invalid" });
  });

  it("keeps the legacy question_id=option_id syntax", () => {
    const c = card([singleQ]);
    expect(parseLegacyAnswerSyntax(c, "db=pg,sqlite\nnope=1")).toEqual([{ questionId: "db", optionIds: ["pg"] }]);
    expect(parseLegacyAnswerSyntax(c, "just text")).toEqual([]);
  });

  it("reads typed confirmations", () => {
    expect(confirmationFromText("Tak")).toEqual({ action: "accept" });
    expect(confirmationFromText("not before Friday")).toEqual({ action: "reject", reason: "not before Friday" });
  });
});

describe("callback data", () => {
  it("round-trips option, submit and legacy buttons within Telegram's 64 bytes", () => {
    expect(parseCardCallback("qc:o:2:11")).toEqual({ type: "option", q: 2, o: 11 });
    expect(parseCardCallback("qc:s")).toEqual({ type: "submit" });
    expect(parseCardCallback("interaction_accept")).toEqual({ type: "accept" });
    expect(parseCardCallback("qc:o:-1:0")).toBeNull();
    expect(parseCardCallback("approve_123")).toBeNull();
  });
});

describe("rendering", () => {
  it("shows who asks, where, why and one button per option", () => {
    const c = card([singleQ]);
    const { text, keyboard } = renderCard(c, links);
    expect(text).toContain("*Ant asks*");
    expect(text).toContain("Pick a DB");
    expect(text).toContain("Two options fit\\.");
    expect(keyboard.map((row) => row[0]!.text)).toEqual(["Postgres", "SQLite", "Open XPL-7"]);
    for (const row of keyboard) {
      for (const button of row) {
        if (button.callback_data) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      }
    }
  });

  it("marks selections and adds Send when more than one tap is needed", () => {
    const c = card([{ ...singleQ, selectionMode: "multi" }]);
    toggleOption(c, 0, 1);
    const { keyboard } = renderCard(c, links);
    expect(keyboard.map((row) => row[0]!.text)).toEqual(["Postgres", "✅ SQLite", "📨 Send", "Open XPL-7"]);
  });

  it("closes a card with the answer summary", () => {
    const c = card([singleQ]);
    toggleOption(c, 0, 0);
    const text = renderClosedCard(c, links, "answered", { byWhom: "mateusz", answers: buildAnswers(c) });
    expect(text).toContain("Which database?: Postgres");
    expect(text).toContain("Answered by mateusz");
  });

  it("says when the agent withdrew the question", () => {
    expect(renderClosedCard(card([singleQ]), links, "expired")).toContain("Expired \\- the agent moved on*");
  });

  it("never drops a question/option even when dropping narrative text alone cannot fit the card under 4096 chars", () => {
    // Long prompts are never truncated by the compact pass (only the agent's
    // excerpt and per-question help text are), so enough of them still forces
    // the hard-truncate fallback - which must still keep every button.
    const longPrompt = "What should we do about this specific aspect of the rollout, concretely and in detail? ".repeat(3);
    const questions = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`,
      prompt: `${i + 1}. ${longPrompt}`,
      selectionMode: "single" as const,
      required: true,
      options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
    }));
    const c = card(questions);
    const { text, keyboard } = renderCard(c, links);

    expect(text.length).toBeLessThanOrEqual(4096);
    // Every question's every option is still a working button - nothing silently dropped.
    for (let qi = 0; qi < 20; qi++) {
      for (let oi = 0; oi < 2; oi++) {
        expect(keyboard.some((row) => row[0]!.callback_data === `qc:o:${qi}:${oi}`)).toBe(true);
      }
    }
    expect(text).toContain("Open in Paperclip to see all 20 questions");
  });
});

describe("reminders", () => {
  const base = { ...card([singleQ]), deliveredAt: 0 };
  it("fires after the interval, up to the limit", () => {
    expect(isReminderDue(base, 59 * 60_000, 60, 2)).toBe(false);
    expect(isReminderDue(base, 60 * 60_000, 60, 2)).toBe(true);
    expect(isReminderDue({ ...base, reminders: 2 }, 10 * 3_600_000, 60, 2)).toBe(false);
    expect(isReminderDue({ ...base, reminders: 1, lastReminderAt: 60 * 60_000 }, 90 * 60_000, 60, 2)).toBe(false);
    expect(isReminderDue(base, 10 * 3_600_000, 0, 2)).toBe(false);
  });
});

describe("agent markdown in cards", () => {
  it("keeps bold, code and bullets, drops board-relative links to their label", () => {
    const v2 = agentMarkdownToV2("## Co robimy\n- **Spec rew. 5 ([spec](/XPL/issues/XPL-6#document-spec))** ok\n- `PUT /calibration/settings` (2.0)");
    expect(v2).toBe("*Co robimy*\n• *Spec rew\\. 5 \\(spec\\)* ok\n• `PUT /calibration/settings` \\(2\\.0\\)");
  });

  it("drops a pair opener cut off by truncation instead of printing it", () => {
    expect(agentMarkdownToV2("**Kod klienta w run")).toBe("Kod klienta w run");
  });

  it("collapses long confirmation details and hides the duplicate agent comment", () => {
    const card = cardFromInteraction(
      {
        id: "int-9", issueId: "iss-1", companyId: "co-1", kind: "request_confirmation",
        payload: {
          prompt: "EE-3529: zaczynamy implementację?",
          detailsMarkdown: "**Co robimy.** Kod klienta\n- punkt 1\n- punkt 2",
          acceptLabel: "Tak, implementuj (rekomendowane warianty)",
        },
      },
      { ...context, excerpt: "Spec approved przez Anta, długi komentarz" },
    )!;
    const { text, keyboard } = renderCard(card, links);
    expect(text).not.toContain("długi komentarz");
    expect(text).toContain("**>*Co robimy\\.* Kod klienta\n>• punkt 1\n>• punkt 2||");
    expect(keyboard[0]![0]!.text.length).toBeLessThanOrEqual(34);
  });
});
