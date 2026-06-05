import { describe, expect, it } from "vitest";

import {
  taskBoardReducer,
  upsertTaskBoardCard,
} from "@/features/office/tasks/taskBoardState";
import type { TaskBoardCard } from "@/features/office/tasks/types";

const makeCard = (overrides: Partial<TaskBoardCard> = {}): TaskBoardCard => ({
  id: "task-1",
  title: "Check Hermes connection",
  description: "",
  status: "todo",
  source: "openclaw_event",
  sourceEventId: "task-1",
  assignedAgentId: "hermes",
  createdAt: "2026-06-05T08:00:00.000Z",
  updatedAt: "2026-06-05T08:00:00.000Z",
  playbookJobId: null,
  runId: null,
  channel: null,
  externalThreadId: null,
  lastActivityAt: null,
  notes: [],
  isArchived: false,
  isInferred: false,
  ...overrides,
});

describe("task board state", () => {
  it("keeps the same cards array when upserting a structurally identical card", () => {
    const cards = [makeCard()];

    expect(upsertTaskBoardCard(cards, makeCard())).toBe(cards);
  });

  it("keeps the same preference object when reducer upsert is unchanged", () => {
    const state = {
      cards: [makeCard()],
      selectedCardId: "task-1",
    };

    expect(taskBoardReducer(state, { type: "upsert", card: makeCard() })).toBe(
      state,
    );
  });
});
