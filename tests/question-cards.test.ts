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
  parseLegacyAnswerSyntax,
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
