Short answer: **Roo Code** is generally better than Cline if you want flexible multi-model support, including Kimi. Cline is more opinionated/autonomous and historically built around Claude. Roo Code lets you pick the provider/model per task and has a simpler mental model for switching.

On your other points:

* **Kimi Code: vs Kilo Code:** Kilo Code: looks like a fork/wrapper. The task-condensation bug you're hitting is likely Kilo-specific, not Kimi-model-specific. Kimi's own VS Code: extension (`<span>Kimi Code:</span>`) or using Roo Code/Cline with Kimi via OpenRouter avoids that.
* **K2.7:** Yes, Kimi k2.7 is a real Kimi model. If you're hitting it through Kilo, you may not be getting the actual model you selected.
* **Where to build Wrappy:** Keep it in the Reprompty repo for now. It's tiny and you already said Reprompty integration comes later. Moving it to its own repo later is one `<span>git subtree</span>` command. Don't clone Roo/Cline and try to Frankenstein pieces — both are large extensions with heavy state machines. Start barebones, borrow specific patterns only when you need them.

**My recommendation:** Use Wrappy as the minimal chat wrapper, and drive the actual coding agent through **Roo Code** + Kimi (via OpenRouter or direct Kimi API if Roo supports it). That gives you the task control you want without Kilo's condensation loop.

Want me to check what's in `<span>/home/tope/Projects/OS-Toolkit/kilocode-legacy/</span>` to see if any pieces are worth salvaging?

.
