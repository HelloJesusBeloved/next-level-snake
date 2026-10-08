// The ending position of a run, as the game engine reports it.
//
// Cells are stored as y * cols + x indexes (not [x, y] pairs): a 432-cell snake
// is then ~1.7 KB instead of ~5 KB, which matters because the profile page
// loads the whole game log in one request.
export type EndState = {
  cols: number;
  rows: number;
  snake: number[]; // head first
  food: number | null;
  crash: number | null; // the cell the snake ran into, null when the player quit
  cause: "crash" | "quit";
};

const MAX_DIMENSION = 64;

function cellOrNull(value: unknown, cells: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < cells
    ? value
    : null;
}

// Never trust the client: rebuild the object from validated pieces, or return
// null. A bad snapshot must not stop the score itself from being saved.
export function sanitizeEndState(raw: unknown): EndState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const { cols, rows } = input;
  if (
    typeof cols !== "number" || !Number.isInteger(cols) ||
    typeof rows !== "number" || !Number.isInteger(rows) ||
    cols < 2 || rows < 2 || cols > MAX_DIMENSION || rows > MAX_DIMENSION
  ) {
    return null;
  }
  const cells = cols * rows;

  const snake = input.snake;
  if (!Array.isArray(snake) || snake.length < 1 || snake.length > cells) return null;
  const seen = new Set<number>();
  for (const cell of snake) {
    if (cellOrNull(cell, cells) === null || seen.has(cell as number)) return null;
    seen.add(cell as number);
  }

  const crash = cellOrNull(input.crash, cells);
  return {
    cols,
    rows,
    snake: snake as number[],
    food: cellOrNull(input.food, cells),
    crash,
    cause: input.cause === "crash" && crash !== null ? "crash" : "quit",
  };
}
