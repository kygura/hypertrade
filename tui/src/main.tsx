import { useEffect } from "react";
import { render, Text, useApp } from "ink";
import { fmtPx } from "../../src/shared/format.js";
import { isPrivateKey } from "../../src/server/desk/hl/signing.js";

function App() {
  const { exit } = useApp();
  useEffect(() => {
    exit();
  }, [exit]);
  return (
    <Text>
      hypertrade tui — scaffold (fmtPx 61234.5 = {fmtPx(61234.5)}, isPrivateKey(undefined) = {String(isPrivateKey(undefined))})
    </Text>
  );
}

render(<App />);
