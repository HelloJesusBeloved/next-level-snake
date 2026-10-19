import { useEffect, useRef, useState } from "react";

type Skin = "classic" | "arcade" | "vintage" | "terminal" | "paper" | "violet" | "sunsetfire";
type Phase = "ready" | "running" | "paused" | "over" | "hacking";
type Palette = { field: string; snake: string; food: string; blocks?: boolean; blockGap?: number };
type Run = { score: number; cause: "quit" | "crash"; at: number };
type GameState = { score: number; endState?: { cause: "quit" | "crash" } };
type Game = {
  start(): boolean; pause(): boolean; resume(): boolean; quit(): void; destroy(): void;
  setTheme(palette: Palette): void; setSpeed(id: number): void; setGrowth(n: number): void;
  on(event: string, handler: (state: GameState | number) => void): Game;
};
type SnakeWindow = Window & { SnakeGame?: { create(root: HTMLElement, opts: object): Game } };

const skins: { id: Skin; name: string; palette: Palette }[] = [
  { id: "classic", name: "Classic", palette: { field: "#000000", snake: "#35FF6B", food: "#FF3B30", blocks: true } },
  { id: "arcade", name: "Arcade", palette: { field: "#050505", snake: "#2CE05E", food: "#FF3B30" } },
  { id: "vintage", name: "Vintage", palette: { field: "#B8C69A", snake: "#1E2C16", food: "#1E2C16", blocks: true, blockGap: 0.12 } },
  { id: "terminal", name: "Terminal", palette: { field: "#020805", snake: "#31F084", food: "#FF4141" } },
  { id: "paper", name: "Paper", palette: { field: "#F6F1E2", snake: "#191713", food: "#C8102E" } },
  { id: "violet", name: "Midnight Violet", palette: { field: "#0B0617", snake: "#7DF4FF", food: "#FF7AC8" } },
  { id: "sunsetfire", name: "Royal Sunset", palette: { field: "#180306", snake: "#FFD34E", food: "#FF5839" } },
];
const speeds = ["Chill", "Easy", "Normal", "Fast", "Insane", "Ludicrous"];
function savedTheme(): Skin {
  try { return skins.find(({ id }) => id === localStorage.getItem("snake.vite-theme"))?.id ?? "classic"; }
  catch { return "classic"; }
}

// Small standalone wrapper for the same public/game.js that the Rails container uses.
// The production UI, accounts and profile are in rails/app/views + public/app.js.
export default function App() {
  const root = useRef<HTMLDivElement>(null);
  const game = useRef<Game | null>(null);
  const themeRef = useRef<Skin>("classic");
  const [theme, setTheme] = useState<Skin>(savedTheme);
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [final, setFinal] = useState(0);
  const [speed, setSpeed] = useState(3);
  const [growth, setGrowth] = useState(1);
  const [runs, setRuns] = useState<Run[]>([]);
  const [ready, setReady] = useState(false);
  themeRef.current = theme;

  useEffect(() => {
    let active = true;
    let script: HTMLScriptElement | null = null;
    function boot() {
      if (!active || !root.current || !(window as SnakeWindow).SnakeGame) return;
      const instance = (window as SnakeWindow).SnakeGame!.create(root.current, { speedId: 3, growth: 1 });
      game.current = instance;
      instance.on("score", (n) => setScore(Number(n)));
      instance.on("start", () => { setScore(0); setPhase("running"); });
      instance.on("pause", () => setPhase("paused"));
      instance.on("resume", () => setPhase("running"));
      instance.on("hackstart", () => setPhase("hacking"));
      instance.on("hackend", () => setPhase("ready"));
      instance.on("gameover", (value) => {
        const state = value as GameState;
        const cause: Run["cause"] = state.endState?.cause === "quit" ? "quit" : "crash";
        setFinal(state.score);
        setPhase("over");
        if (cause === "crash" || state.score > 10) {
          setRuns((old) => [{ score: state.score, cause, at: Date.now() }, ...old].slice(0, 10));
        }
      });
      instance.setTheme(skins.find(({ id }) => id === themeRef.current)!.palette);
      setReady(true);
    }
    if ((window as SnakeWindow).SnakeGame) boot();
    else {
      script = document.createElement("script");
      script.src = "/game.js";
      script.onload = boot;
      document.body.appendChild(script);
    }
    return () => { active = false; game.current?.destroy(); game.current = null; script?.remove(); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    game.current?.setTheme(skins.find(({ id }) => id === theme)!.palette);
    try { localStorage.setItem("snake.vite-theme", theme); } catch { /* optional */ }
  }, [theme]);
  useEffect(() => {
    document.body.classList.toggle("has-run", phase === "running" || phase === "paused");
    return () => document.body.classList.remove("has-run");
  }, [phase]);

  const locked = phase === "running" || phase === "paused";
  const best = Math.max(0, ...runs.filter((run) => run.cause !== "quit").map((run) => run.score));
  const overlay = phase === "ready" || phase === "paused" || phase === "over";
  return <>
    <div className="page-texture" aria-hidden="true" /><div className="page-scrim" aria-hidden="true" />
    <div className="spine" aria-hidden="true"><span>Next Level Snake / Wall-Wrap Arcade</span></div>
    <header className="masthead"><div className="masthead__brand-group">
      <div className="masthead__brand"><span className="mark" aria-hidden="true" />
        <span className="brand__text"><span className="brand__eyebrow">Next Level</span><span className="wordmark">Snake</span></span></div>
      <span className="brand__credit">Made almost entirely with <a href="https://arena.ai" target="_blank" rel="noreferrer">arena.ai</a> ❤️</span>
    </div>
      <nav className="masthead__meta"><a className="btn btn--small btn--nav" href="https://github.com/HelloJesusBeloved/next-level-snake" target="_blank" rel="noreferrer">Open Source</a></nav>
    </header>
    <main className="shell"><section className="stage" aria-label="Snake game">
      <div className="stage__head"><p className="stage__eyebrow">The game</p>
        <h1 className="stage__title">Beautiful.<br />Modern.<br /><em>Snake.</em></h1>
        <p className="stage__sub">One green body, one red box of food. Walls wrap. Use arrow keys, WASD or a swipe to steer.</p></div>
      <div className="hud" id="hud" aria-label="Current run">
        <div className="hud__cell"><span className="hud__label">Score</span><span className="hud__value hud__value--score">{score}</span></div>
        <div className="hud__cell"><span className="hud__label">Best</span><span className="hud__value">{best}</span></div>
        <div className="hud__cell hud__cell--mode"><span className="hud__label">Mode</span><span className="hud__mode">{speeds[speed - 1]} / x{growth}</span></div>
      </div>
      <div className="screen"><div id="snake-root" ref={root} />
        <div id="overlay" className={"overlay" + (overlay ? " is-visible" : "")}>
          {phase === "ready" && <div className="panel is-visible"><p className="panel__eyebrow">Ready</p><h2 className="panel__title">Press a direction to start</h2>
            <p className="panel__body">Arrow keys, WASD or swipe to steer. In Terminal, tap the game box to type hacker code.</p>
            <div className="panel__actions"><button className="btn btn--primary" type="button" disabled={!ready} onClick={() => game.current?.start()}>Start game</button></div></div>}
          {phase === "paused" && <div className="panel is-visible"><p className="panel__eyebrow">Held</p><h2 className="panel__title">Paused</h2>
            <div className="panel__actions"><button className="btn btn--primary" type="button" onClick={() => game.current?.resume()}>Resume</button><button className="btn" type="button" onClick={() => game.current?.quit()}>Quit run</button></div></div>}
          {phase === "over" && <div className="panel is-visible"><p className="panel__eyebrow">Run complete</p><h2 className="panel__title">Game over</h2>
            <p className="panel__body">Final score: {final}. Quits count only above 10 points.</p>
            <div className="panel__actions"><button className="btn btn--primary" type="button" onClick={() => game.current?.start()}>Play again</button><button className="btn" type="button" onClick={() => setPhase("ready")}>Exit</button></div></div>}
        </div>
      </div>
      <div className="pausebar"><button type="button" className="btn" onClick={() => phase === "paused" ? game.current?.resume() : game.current?.pause()}>{phase === "paused" ? "Unpause" : "Pause"}</button></div>
    </section><aside className="rail" aria-label="Game settings">
      <div className="card card--score" id="scoreboard"><div className="card__head"><h2 className="card__title">Scoreboard</h2><span className="mode-chip">{speeds[speed - 1]} / x{growth}</span></div>
        <div className="stat-tiles"><div className="stat"><span className="stat__label">Score</span><span className="stat__value stat__value--live">{score}</span></div><div className="stat"><span className="stat__label">Best</span><span className="stat__value">{best}</span></div></div>
        <h3 className="mini-title">Recent runs <span>this session</span></h3><ol className="runs">{runs.length ? runs.map((run) => <li className={"runs__item" + (run.cause === "quit" ? " is-quit" : "")} key={run.at}>
          <span className="runs__score">{run.score}</span><span className="runs__mode">{run.cause === "quit" ? "Quit" : "Completed"}</span><span className="runs__when">just now</span></li>) : <li className="runs__empty">Play a run and it shows up here.</li>}</ol>
      </div>
      <div className="card" id="settings-card"><div className="card__head"><h2 className="card__title">Modifiers</h2>{locked && <span className="lock-badge">In play - locked</span>}</div>
        <div className="setting"><div className="setting__head"><h3>Theme</h3><span className="setting__value">{skins.find(({ id }) => id === theme)?.name}</span></div>
          <div className="segmented" role="group" aria-label="Theme">{skins.map((skin) => <button key={skin.id} type="button" data-theme={skin.id} aria-pressed={skin.id === theme} disabled={locked} onClick={() => setTheme(skin.id)}><span className="swatch" data-swatch={skin.id}><i aria-hidden="true" />{skin.name}</span></button>)}</div></div>
        <div className="setting"><div className="setting__head"><h3>Snake speed</h3></div><div className="segmented" role="group" aria-label="Snake speed">{speeds.map((label, i) => <button key={label} type="button" aria-pressed={speed === i + 1} disabled={locked} onClick={() => { setSpeed(i + 1); game.current?.setSpeed(i + 1); }}>{label}</button>)}</div></div>
        <div className="setting"><div className="setting__head"><h3>Growth per food</h3></div><div className="segmented" role="group" aria-label="Growth per food">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={growth === n} disabled={locked} onClick={() => { setGrowth(n); game.current?.setGrowth(n); }}>x{n}</button>)}</div></div>
      </div>
      <div className="card" id="controls-card"><div className="card__head"><h2 className="card__title">Controls</h2></div><p>WASD or arrow keys to steer. P to pause. On a phone, swipe anywhere while playing.</p></div>
    </aside></main>
    <footer className="footer"><span>Next Level Snake / Wall-Wrap Arcade</span><span>Accounts and leaderboards are served by the Rails container.</span></footer>
  </>;
}
