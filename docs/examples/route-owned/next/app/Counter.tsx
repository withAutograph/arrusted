"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div className="counter" aria-label="Interactive client island">
      <p>
        Client island count: <strong>{count}</strong>
      </p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
    </div>
  );
}
