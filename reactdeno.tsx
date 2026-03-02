import * as React from "npm:react";

const el = React.createElement("h1", {}, "Hello!");
el;
<h1>Hello!</h1>;

import { renderToString } from "npm:react-dom/server";

renderToString(<h1>Hello!</h1>);

function renderToJupyter(el) {
  return {
    [Deno.jupyter.$display]: () => {
      return {
        "text/html": renderToString(el),
      };
    },
  };
}

renderToJupyter(<h1>Hello!</h1>);

renderToJupyter(
  <div>
    <h1 key="we-did-it">Greetings from React!</h1>
    <p>We just did React in Deno → Zed → React in ...Zed?</p>
  </div>,
);
