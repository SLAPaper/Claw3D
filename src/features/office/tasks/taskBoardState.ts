import {
  defaultTaskBoardPreference,
  type TaskBoardCard,
  type TaskBoardPreference,
  type TaskBoardStatus,
} from "@/features/office/tasks/types";

type TaskBoardAction =
  | { type: "hydrate"; preference: TaskBoardPreference }
  | { type: "upsert"; card: TaskBoardCard }
  | { type: "upsertMany"; cards: TaskBoardCard[] }
  | { type: "update"; cardId: string; patch: Partial<TaskBoardCard> }
  | { type: "move"; cardId: string; status: TaskBoardStatus }
  | { type: "remove"; cardId: string }
  | { type: "select"; cardId: string | null };

const compareCards = (left: TaskBoardCard, right: TaskBoardCard) => {
  const leftArchived = left.isArchived ? 1 : 0;
  const rightArchived = right.isArchived ? 1 : 0;
  if (leftArchived !== rightArchived) return leftArchived - rightArchived;
  const leftAt = Date.parse(left.updatedAt) || 0;
  const rightAt = Date.parse(right.updatedAt) || 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return left.title.localeCompare(right.title);
};

export const sortTaskBoardCards = (cards: TaskBoardCard[]): TaskBoardCard[] =>
  [...cards].sort(compareCards);

const areStringArraysEqual = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const areTaskBoardCardsEqual = (
  left: TaskBoardCard,
  right: TaskBoardCard,
): boolean =>
  left.id === right.id &&
  left.title === right.title &&
  left.description === right.description &&
  left.status === right.status &&
  left.source === right.source &&
  left.sourceEventId === right.sourceEventId &&
  left.assignedAgentId === right.assignedAgentId &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  left.playbookJobId === right.playbookJobId &&
  left.runId === right.runId &&
  left.channel === right.channel &&
  left.externalThreadId === right.externalThreadId &&
  left.lastActivityAt === right.lastActivityAt &&
  left.isArchived === right.isArchived &&
  left.isInferred === right.isInferred &&
  areStringArraysEqual(left.notes, right.notes);

export const upsertTaskBoardCard = (
  cards: TaskBoardCard[],
  nextCard: TaskBoardCard,
): TaskBoardCard[] => {
  const cardId = nextCard.id.trim();
  if (!cardId) return cards;
  const existingIndex = cards.findIndex((card) => card.id === cardId);
  if (existingIndex < 0) return sortTaskBoardCards([...cards, nextCard]);
  if (areTaskBoardCardsEqual(cards[existingIndex], nextCard)) return cards;
  const next = [...cards];
  next[existingIndex] = nextCard;
  return sortTaskBoardCards(next);
};

export const taskBoardReducer = (
  state: TaskBoardPreference = defaultTaskBoardPreference(),
  action: TaskBoardAction,
): TaskBoardPreference => {
  switch (action.type) {
    case "hydrate":
      return {
        cards: sortTaskBoardCards(action.preference.cards),
        selectedCardId: action.preference.selectedCardId,
      };
    case "upsert": {
      const cards = upsertTaskBoardCard(state.cards, action.card);
      if (cards === state.cards) return state;
      return {
        ...state,
        cards,
      };
    }
    case "upsertMany": {
      let cards = state.cards;
      for (const card of action.cards) {
        cards = upsertTaskBoardCard(cards, card);
      }
      if (cards === state.cards) return state;
      return { ...state, cards };
    }
    case "update": {
      const existing = state.cards.find((card) => card.id === action.cardId);
      if (!existing) return state;
      return {
        ...state,
        cards: upsertTaskBoardCard(state.cards, {
          ...existing,
          ...action.patch,
          updatedAt: action.patch.updatedAt ?? new Date().toISOString(),
        }),
      };
    }
    case "move": {
      const existing = state.cards.find((card) => card.id === action.cardId);
      if (!existing) return state;
      return {
        ...state,
        cards: upsertTaskBoardCard(state.cards, {
          ...existing,
          status: action.status,
          updatedAt: new Date().toISOString(),
        }),
      };
    }
    case "remove": {
      const cards = state.cards.filter((card) => card.id !== action.cardId);
      return {
        cards,
        selectedCardId:
          state.selectedCardId === action.cardId ? cards[0]?.id ?? null : state.selectedCardId,
      };
    }
    case "select":
      if (state.selectedCardId === action.cardId) return state;
      return {
        ...state,
        selectedCardId: action.cardId,
      };
    default:
      return state;
  }
};
