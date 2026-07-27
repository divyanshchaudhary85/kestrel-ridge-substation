# Kestrel Ridge Substation

An interactive 3D electrical substation and distribution network, built as an operator-training and teaching tool. One self-contained HTML file, no build step.

**Live demo:** https://divyanshchaudhary85.github.io/kestrel-ridge-substation/

---

## What it is

A 230/34.5 kV distribution substation modelled at 1 unit = 1 metre, from the generating station through the transmission line, the switchyard and the transformers, out along four feeders to 132 homes — 69 of them with rooftop solar and grid-tied inverters.

Everything visible is a consequence of the electrical model underneath. Energisation is solved by graph search from the source every time a switch moves, so opening a breaker propagates through to dark windows, stopped power-flow arrows, customer counts and transformer loading without anything being hard-coded.

## Features

- **46 selectable components**, each with purpose, normal condition, fault behaviour, SCADA linkage, ratings, first principles and the governing equations — 194 equations in total, each with a worked example using the station's own numbers.
- **32 animated working models.** Click a breaker and inject a fault to watch the contacts part and the arc die at a current zero; open the relay to see the IEEE inverse-time curve with a moving operating point; watch the tap changer perform a make-before-break transition.
- **14 operator scenarios**, 89 steps, each explaining what the operator is doing, why, which equipment is involved, how power flow changes, what protection is doing in the background, and the effect on customers and solar.
- **FISR** — fault location, isolation and service restoration. Injects a fault, locates it from faulted-circuit indicators, isolates it with sectionalising switches, restores upstream from the substation and back-feeds downstream through a tie switch, with a real donor-capacity check.
- **14 SEL relays** with live settings: reclosing enable, pickup currents, time dials, FISR mode, and hot-line tags that genuinely block every close path.
- **Interlocks that bite.** Opening a disconnect under load or earthing a live section is refused, with the physics explained.
- **Distributed solar.** An irradiance control drives both generation and the daily load curve, so feeders genuinely reverse and export around solar noon.
- **Network state colouring** — green de-energised, dark pink for closed loops inside the station, red pulsing for faults, amber and orange for thermal loading.

## Running it

Open `index.html` in any modern browser. Nothing to install.

Three.js and the fonts load from CDNs, so an internet connection is needed to view it.

## Controls

Drag to orbit, scroll or pinch to zoom, right-drag to pan. Five camera modes across the top; the operator panel is on the left; click any equipment to open its nameplate.

## Notes

Kestrel Ridge is a fictional station. Voltages, ratings, protection settings and layout follow North American utility practice closely enough to be instructive, but this is a teaching model, not a design document.

Lamp convention is genuine and catches people out: **red means closed and energised, green means open and safe.**
