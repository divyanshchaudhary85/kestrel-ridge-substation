(function () {
  "use strict";

  const N = window.__OPS_NET;
  const O = window.__OPS;
  const X = window.__OPS2;
  const COLOUR = window.__COLOUR;
  if (!N || !O || !X) return;

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const esc = (value) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const PREF_KEY = "kestrel-ridge-scada-v3";
  let prefs = { theme: "dark", sound: false, powerFlow: false };
  try {
    prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || "{}"));
  } catch (_) {}

  const savePrefs = () => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch (_) {}
  };

  const ui = {
    tab: "events",
    selectedComp: null,
    selectedDevice: null,
    requestedDevice: null,
    openOnSelect: false,
    selectedEvent: null,
    equipmentFilter: "all",
    powerFlow: !!prefs.powerFlow,
    sound: !!prefs.sound,
    pendingCommand: null,
    eventSequence: 0,
    audio: null,
  };

  const events = [];
  const alarms = new Map();
  const deviceStates = new Map(
    Object.values(N.DEV).map((device) => [device.id, !!device.closed])
  );
  const relayStates = new Map();
  X.RLY.forEach((relay) => {
    Object.keys(relay.set).forEach((key) => {
      relayStates.set(relay.id + "|" + key, relay.set[key]);
    });
  });

  function nowTime(date) {
    const d = date || new Date();
    return (
      d.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  }

  function typeFor(device, compId) {
    if (device) {
      return (
        {
          breaker: "Circuit breaker",
          disc: "Disconnect switch",
          gnd: "Earthing switch",
          sect: "Sectionalising switch",
          tie: "Tie switch",
        }[device.kind] || "Primary equipment"
      );
    }
    const key = String(compId || "").toLowerCase();
    if (/xfmr|transform|oltc|dist_/.test(key)) return "Transformer";
    if (/bus/.test(key)) return "Bus";
    if (/relay|scada|battery/.test(key)) return "Protection & control";
    if (/solar|pv|gen/.test(key)) return "Generation / DER";
    if (/line|tower|feeder/.test(key)) return "Line / feeder";
    if (/cap/.test(key)) return "Reactive power equipment";
    if (/house|office|factory|ev|street/.test(key)) return "Customer load";
    return "Substation equipment";
  }

  function deviceLive(device) {
    if (!device) return null;
    if (device.kind === "gnd") return N.isLive(device.node);
    return N.isLive(device.a) || N.isLive(device.b);
  }

  function deviceEnergy(device) {
    if (!device) return { label: "Energized", cls: "live", oos: false };
    if (device.kind === "gnd") {
      const live = N.isLive(device.node);
      return {
        label: live ? "Section energized" : "Section de-energized",
        cls: live ? "warning" : "dead",
        oos: false,
      };
    }
    const sideA = device.a ? N.isLive(device.a) : false;
    const sideB = device.b ? N.isLive(device.b) : false;
    if (sideA && sideB) return { label: "Energized", cls: "live", oos: false };
    if (sideA || sideB) {
      return {
        label: "One side energized",
        cls: "warning",
        oos: !device.closed && !sideB,
      };
    }
    return { label: "De-energized", cls: "dead", oos: !device.closed };
  }

  function componentEnergy(compId) {
    const allFeederNodes = [];
    for (let feeder = 0; feeder < 4; feeder += 1) {
      allFeederNodes.push("FD" + feeder);
      for (let section = 0; section < 3; section += 1) {
        allFeederNodes.push(N.SEC(feeder, section));
      }
    }
    const groups = {
      gen: ["SRC"],
      tower: ["TL1", "TL2"],
      takeoff: ["TL1", "TL2"],
      arrester_hv: ["TL1", "TL2"],
      cvt: ["TL1", "TL2"],
      busA: ["BUSA"],
      busB: ["BUSB"],
      xfmr: ["XF1", "XF1S", "XF2", "XF2S"],
      bushing: ["XF1", "XF1S", "XF2", "XF2S"],
      radiator: ["XF1", "XF1S", "XF2", "XF2S"],
      conservator: ["XF1", "XF1S", "XF2", "XF2S"],
      oltc: ["XF1", "XF1S", "XF2", "XF2S"],
      swgr: ["MVA", "MVB"],
      capbank: ["MVA", "MVB"],
      feeder: allFeederNodes,
      dist_xfmr: allFeederNodes,
      house: allFeederNodes,
      office: allFeederNodes,
      factory: allFeederNodes,
      streetlight: allFeederNodes,
      evcharger: allFeederNodes,
      solar_home: allFeederNodes,
      community_solar: allFeederNodes,
      volt_reg: allFeederNodes,
    };
    const nodes = groups[compId];
    if (!nodes || !nodes.length) {
      return { label: "Status available", cls: "normal", oos: false };
    }
    const liveCount = nodes.filter((node) => N.isLive(node)).length;
    if (liveCount === nodes.length) {
      return { label: "Energized", cls: "live", oos: false };
    }
    if (liveCount > 0) {
      return { label: "Partially energized", cls: "warning", oos: false };
    }
    return { label: "De-energized", cls: "dead", oos: true };
  }

  function snapshot() {
    const fs = N.systemState();
    const totalCustomers = N.FEED.reduce((sum, feeder) => sum + feeder.cust, 0);
    const customersOut = fs.reduce((sum, feeder) => sum + feeder.outCust, 0);
    const totalLoad = fs.reduce((sum, feeder) => sum + feeder.load, 0);
    const totalSolar = fs.reduce((sum, feeder) => sum + feeder.solar, 0);
    let loopCount = 0;
    try {
      loopCount = COLOUR && COLOUR.loops ? COLOUR.loops().nodes.size : 0;
    } catch (_) {}
    return {
      fs,
      totalCustomers,
      customersOut,
      customersServed: totalCustomers - customersOut,
      totalLoad,
      totalSolar,
      netMW: totalLoad - totalSolar,
      t1Pct: Math.round((N.ST.mva1 / 50) * 100),
      t2Pct: Math.round((N.ST.mva2 / 50) * 100),
      fault: N.ST.fault,
      faultSec: N.ST.faultSec || null,
      loopCount,
      liveNodes: new Set(Array.from(N.LIVEREF())),
      sun: Number(N.SUN.v),
      tapT1: X.TAP ? Number(X.TAP.t1) : null,
      tapT2: X.TAP ? Number(X.TAP.t2) : null,
      shed: (N.ST.shed || []).slice().sort().join(","),
      scenarioName: O.SCEN && O.SCEN.active ? O.SCEN.active.name : null,
      scenarioStep: O.SCEN && O.SCEN.active ? Number(O.SCEN.i) : -1,
      fisrActive: !!(X.FISR && X.FISR.plan),
      fisrStep: X.FISR ? Number(X.FISR.i) : -1,
    };
  }

  let previousSnapshot = snapshot();

  function sourceFor(deviceId) {
    if (ui.pendingCommand && ui.pendingCommand.id === deviceId) return "Operator / HMI";
    if (X.FISR && X.FISR.plan && X.FISR.i >= 0) return "SEL-3530 RTAC / FISR";
    if (O.SCEN && O.SCEN.active) return "Training scenario";
    return "System automation";
  }

  function priorityClass(priority) {
    return String(priority || "Advisory").toLowerCase();
  }

  function addEvent(data) {
    const event = Object.assign(
      {
        id: "EV-" + String(++ui.eventSequence).padStart(4, "0"),
        at: new Date(),
        kind: "event",
        priority: "Advisory",
        equipment: "Kestrel Ridge",
        operation: "Status update",
        previous: "—",
        next: "—",
        source: "System",
        success: true,
        effect: "No change to the electrical network.",
        explanation: null,
      },
      data || {}
    );
    events.unshift(event);
    if (events.length > 300) events.length = 300;
    if (!ui.selectedEvent) ui.selectedEvent = event;
    renderCurrentPane();
    return event;
  }

  function defaultExplanation(event) {
    return {
      command:
        event.operation +
        (event.equipment ? " was recorded for " + event.equipment + "." : "."),
      equipment:
        event.equipment +
        " changed from " +
        event.previous +
        " to " +
        event.next +
        ".",
      power: event.effect,
      affected:
        "The simulator recalculated every connected bus, line, feeder, transformer, customer section, and DER path from the updated topology.",
      alarm:
        event.priority === "Critical" || event.priority === "High"
          ? "This condition created an operator alarm that should be acknowledged after it is understood."
          : "No high-priority alarm was required for this operation.",
      verify:
        "Verify the one-line, downstream voltage, current direction, customer impact, and protection targets before issuing the next command.",
    };
  }

  function operationExplanation(device, beforeClosed, afterClosed, before, after) {
    const opened = !afterClosed;
    const command = (afterClosed ? "Close " : "Open ") + device.id;
    const outDelta = after.customersOut - before.customersOut;
    const loadDelta = after.netMW - before.netMW;
    const endpoints =
      device.kind === "gnd" ? device.node : [device.a, device.b].filter(Boolean).join(" and ");
    let why;
    if (device.kind === "gnd") {
      why = afterClosed
        ? "The section was bonded to the station ground grid so it remains at earth potential for safe work."
        : "The safety earth was removed so the section can be prepared for re-energization.";
    } else if (device.kind === "disc") {
      why = opened
        ? "The disconnect creates a visible isolation point after interrupting current with the associated breaker."
        : "The disconnect restores the physical current path after the circuit was proved ready for service.";
    } else if (device.kind === "tie") {
      why = afterClosed
        ? "The tie establishes an alternate source path for load transfer or service restoration."
        : "The tie returns the system toward its normal radial configuration.";
    } else {
      why = opened
        ? "The device removed its downstream path from service for protection, isolation, or operating control."
        : "The device restored an available path after interlocks and topology checks passed.";
    }
    return {
      command: command + " was issued from the operator interface.",
      equipment:
        device.name +
        " moved from " +
        (beforeClosed ? "CLOSED" : "OPEN") +
        " to " +
        (afterClosed ? "CLOSED" : "OPEN") +
        ".",
      power:
        "The connected path at " +
        endpoints +
        " was recalculated. Net station demand changed by " +
        Math.abs(loadDelta).toFixed(1) +
        " MW" +
        (loadDelta < 0 ? " downward." : " upward."),
      affected:
        outDelta > 0
          ? outDelta + " additional customers lost supply."
          : outDelta < 0
            ? Math.abs(outDelta) + " customers were restored."
            : "No additional customers lost supply; alternate sources maintained service.",
      alarm:
        after.customersOut > 0
          ? "An outage alarm is active for the affected feeder section."
          : after.t1Pct > 100 || after.t2Pct > 100
            ? "A transformer overload alarm is active after the topology change."
            : "No outage or overload alarm was created by this command.",
      verify:
        "Confirm " +
        endpoints +
        " on the one-line, compare MW and MVAR direction, check transformer and feeder loading, then review active relay targets before the next operation.",
    };
  }

  function recordOperation(device, beforeClosed, afterClosed, before, after, source) {
    const opened = !afterClosed;
    const outDelta = after.customersOut - before.customersOut;
    const affected =
      outDelta > 0
        ? outDelta + " customers interrupted"
        : outDelta < 0
          ? Math.abs(outDelta) + " customers restored"
          : "no customer interruption";
    const overload = after.fs.find((feeder) => feeder.rate > 1);
    let effect =
      device.name +
      " is now " +
      (afterClosed ? "CLOSED" : "OPEN") +
      "; " +
      affected +
      ".";
    if (overload) {
      effect +=
        " Feeder " +
        (overload.i + 1) +
        " is at " +
        Math.round(overload.rate * 100) +
        "% of its thermal rating.";
    } else if (after.customersOut === 0) {
      effect += " The station remains fully supplied.";
    }
    const priority =
      after.fault != null || overload
        ? "Critical"
        : after.customersOut > 0
          ? "High"
          : opened
            ? "Medium"
            : "Advisory";
    addEvent({
      kind: "action",
      priority,
      equipment: device.name,
      operation: opened ? "Opened" : "Closed",
      previous: beforeClosed ? "CLOSED" : "OPEN",
      next: afterClosed ? "CLOSED" : "OPEN",
      source,
      success: true,
      effect,
      deviceId: device.id,
      explanation: operationExplanation(device, beforeClosed, afterClosed, before, after),
    });
  }

  function recordFailedCommand(device, want, reason) {
    const current = device.closed ? "CLOSED" : "OPEN";
    const event = addEvent({
      kind: "action",
      priority: reason && reason.danger ? "High" : "Medium",
      equipment: device.name,
      operation: (want ? "Close" : "Open") + " command blocked",
      previous: current,
      next: current,
      source: "Operator / HMI",
      success: false,
      effect:
        (reason && reason.why) ||
        "The command was rejected by an interlock, hot-line tag, or protection block. The electrical network did not change.",
      deviceId: device.id,
    });
    event.explanation = {
      command: (want ? "Close " : "Open ") + device.id + " was issued from the HMI.",
      equipment:
        device.name + " remained " + current + " because the permissive conditions were not satisfied.",
      power: "Power flow did not change because the command was not executed.",
      affected: "No customers or connected equipment changed state.",
      alarm:
        "A blocked-operation record was created so the operator can review the interlock before retrying.",
      verify:
        "Read the interlock message, check associated breakers, earthing switches and hot-line tags, then correct the unsafe condition before retrying.",
    };
  }

  function upsertAdvisoryAlarm(key, priority, equipment, title, message, active) {
    const existing = alarms.get(key);
    if (!existing) {
      const alarm = {
        id: key,
        priority,
        equipment,
        title,
        message,
        active: active !== false,
        acknowledged: false,
        raisedAt: new Date(),
        returnedAt: active === false ? new Date() : null,
      };
      alarms.set(key, alarm);
      if (alarm.active) soundAlarm(priority);
      return alarm;
    }
    existing.message = message;
    existing.priority = priority;
    existing.equipment = equipment;
    return existing;
  }

  function setAlarmCondition(key, condition, data) {
    const existing = alarms.get(key);
    if (condition) {
      if (!existing || !existing.active) {
        const alarm = {
          id: key,
          priority: data.priority,
          equipment: data.equipment,
          title: data.title,
          message: data.message,
          scope: data.scope || null,
          active: true,
          acknowledged: false,
          raisedAt: new Date(),
          returnedAt: null,
        };
        alarms.set(key, alarm);
        addEvent({
          kind: "alarm",
          priority: alarm.priority,
          equipment: alarm.equipment,
          operation: alarm.title,
          previous: "NORMAL",
          next: "ACTIVE",
          source: "EMS alarm processor",
          success: true,
          effect: alarm.message,
          explanation: {
            command: "No operator command created this record; the EMS detected an abnormal condition.",
            equipment: alarm.equipment + " entered the " + alarm.title + " condition.",
            power: alarm.message,
            affected:
              "The alarm processor correlated topology, loading and customer state before assigning its priority.",
            alarm:
              alarm.priority +
              " priority means the operator should acknowledge the alarm after identifying the initiating condition.",
            verify:
              "Check the one-line, upstream source, downstream current, protection targets and related alarms; then correct the initiating condition.",
          },
        });
        soundAlarm(alarm.priority);
      } else {
        existing.message = data.message;
        existing.scope = data.scope || existing.scope || null;
      }
    } else if (existing && existing.active) {
      existing.active = false;
      existing.returnedAt = new Date();
      addEvent({
        kind: "normal",
        priority: "Advisory",
        equipment: existing.equipment,
        operation: existing.title + " returned to normal",
        previous: "ACTIVE",
        next: "NORMAL",
        source: "EMS alarm processor",
        success: true,
        effect:
          "The underlying condition is no longer present. The returned alarm may be cleared after review.",
      });
    }
  }

  function reconcileAlarms(state) {
    setAlarmCondition("network-fault", state.fault != null || !!state.faultSec, {
      priority: "Critical",
      equipment:
        state.fault != null ? "Feeder " + (Number(state.fault) + 1) : "Distribution network",
      title: "Fault on energized network",
      message:
        "Protection has identified a faulted circuit section. Review relay targets and isolation status immediately.",
      scope: {
        feeder:
          state.fault != null
            ? Number(state.fault)
            : state.faultSec && state.faultSec.f != null
              ? Number(state.faultSec.f)
              : null,
      },
    });

    state.fs.forEach((feeder) => {
      setAlarmCondition("outage-f" + feeder.i, feeder.outCust > 0, {
        priority: "High",
        equipment: "Feeder " + (feeder.i + 1),
        title: "Customer outage",
        message:
          feeder.outCust +
          " customers are without supply across " +
          feeder.sections.filter((section) => !section.live).length +
          " de-energized section(s).",
        scope: { feeder: feeder.i },
      });
      setAlarmCondition("overload-f" + feeder.i, feeder.rate > 1, {
        priority: "Critical",
        equipment: "Feeder " + (feeder.i + 1),
        title: "Feeder thermal overload",
        message:
          "Current is " +
          Math.round(feeder.amps) +
          " A (" +
          Math.round(feeder.rate * 100) +
          "% of rating). Reduce or transfer load.",
        scope: { feeder: feeder.i },
      });
      setAlarmCondition(
        "warning-f" + feeder.i,
        feeder.rate > 0.85 && feeder.rate <= 1,
        {
          priority: "Medium",
          equipment: "Feeder " + (feeder.i + 1),
          title: "Feeder loading warning",
          message:
            "Current is " +
            Math.round(feeder.amps) +
            " A (" +
            Math.round(feeder.rate * 100) +
            "% of rating).",
          scope: { feeder: feeder.i },
        }
      );
    });

    [
      ["t1", state.t1Pct],
      ["t2", state.t2Pct],
    ].forEach(([id, percent], index) => {
      setAlarmCondition("overload-" + id, percent > 100, {
        priority: "Critical",
        equipment: "Transformer T" + (index + 1),
        title: "Transformer overload",
        message: "Loading is " + percent + "% of the 50 MVA nameplate rating.",
        scope: { transformer: index },
      });
      setAlarmCondition("warning-" + id, percent > 85 && percent <= 100, {
        priority: "Medium",
        equipment: "Transformer T" + (index + 1),
        title: "Transformer loading warning",
        message: "Loading is " + percent + "% of the 50 MVA nameplate rating.",
        scope: { transformer: index },
      });
    });

    setAlarmCondition("closed-loop", state.loopCount > 0, {
      priority: "High",
      equipment: "Station topology",
      title: "Closed parallel path",
      message:
        state.loopCount +
        " network section(s) are part of a closed loop. Verify circulating current and protection coordination.",
    });

    const grounds = Object.values(N.DEV).filter(
      (device) => device.kind === "gnd" && device.closed
    );
    setAlarmCondition("safety-earth", grounds.length > 0, {
      priority: "Advisory",
      equipment: grounds.length ? grounds.map((device) => device.id).join(", ") : "Safety earth",
      title: "Safety earth applied",
      message:
        grounds.length +
        " earthing switch(es) are closed. Re-energization remains blocked until they are removed.",
      scope: { deviceIds: grounds.map((device) => device.id) },
    });
  }

  function activeAlarms() {
    return Array.from(alarms.values()).filter((alarm) => alarm.active);
  }

  function soundAlarm(priority) {
    if (!ui.sound || !/Critical|High/.test(priority)) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ui.audio = ui.audio || new AudioCtx();
      const start = ui.audio.currentTime;
      [0, 0.18].forEach((delay) => {
        const osc = ui.audio.createOscillator();
        const gain = ui.audio.createGain();
        osc.type = "square";
        osc.frequency.value = priority === "Critical" ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, start + delay);
        gain.gain.exponentialRampToValueAtTime(0.055, start + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.11);
        osc.connect(gain).connect(ui.audio.destination);
        osc.start(start + delay);
        osc.stop(start + delay + 0.12);
      });
    } catch (_) {}
  }

  function buildShell() {
    const sun = $("#sunr");
    if (sun && sun.parentElement) sun.parentElement.id = "v3-sun-control";

    const spacer = $("#rail .spacer");
    if (spacer) {
      spacer.insertAdjacentHTML(
        "beforebegin",
        '<div id="v3-header-summary" aria-label="Station status">' +
          '<span class="v3-health" id="v3-station-health">Station normal</span>' +
          '<span class="v3-health" id="v3-scada-health">SCADA online</span>' +
          "</div>"
      );
      spacer.insertAdjacentHTML(
        "afterend",
        '<div id="v3-header-actions">' +
          '<button class="v3-header-btn" id="v3-search-open" title="Find equipment (Ctrl or Command + K)"><span aria-hidden="true">⌕</span><span class="v3-btn-label">Equipment</span></button>' +
          '<button class="v3-header-btn" id="v3-alarm-open" title="Open alarms"><span aria-hidden="true">!</span><span class="v3-btn-label">Alarms</span><span class="v3-count" id="v3-header-alarm-count">0</span></button>' +
          '<button class="v3-header-btn" id="v3-sound" aria-pressed="false" title="Toggle audible alarm"><span aria-hidden="true">◖</span><span class="v3-btn-label">Sound</span></button>' +
          '<button class="v3-header-btn" id="v3-theme" aria-pressed="false" title="Toggle light and dark interface"><span aria-hidden="true">◐</span><span class="v3-btn-label">Theme</span></button>' +
          '<button class="v3-header-btn" id="v3-activity-toggle" aria-pressed="true" title="Show or hide operator activity"><span aria-hidden="true">▤</span><span class="v3-btn-label">Activity</span></button>' +
          "</div>"
      );
    }

    document.body.insertAdjacentHTML(
      "beforeend",
      '<nav id="v3-camera-dock" aria-label="Camera and visualization controls">' +
        '<button class="v3-dock-btn" data-camera="reset" title="Return to the opening camera without changing equipment state"><span aria-hidden="true">↺</span><span class="v3-dock-label">Reset view</span></button>' +
        '<button class="v3-dock-btn" data-camera="fit" title="Fit the entire substation"><span aria-hidden="true">⊡</span><span class="v3-dock-label">Fit station</span></button>' +
        '<button class="v3-dock-btn" data-camera="top" title="Top view"><span aria-hidden="true">⌗</span><span class="v3-dock-label">Top</span></button>' +
        '<button class="v3-dock-btn" data-camera="operator" title="Operator view"><span aria-hidden="true">▣</span><span class="v3-dock-label">Operator</span></button>' +
        '<button class="v3-dock-btn" data-camera="focus" id="v3-focus" title="Focus selected equipment" disabled><span aria-hidden="true">⌖</span><span class="v3-dock-label">Focus</span></button>' +
        '<span class="v3-dock-divider" aria-hidden="true"></span>' +
        '<button class="v3-dock-btn" id="v3-flow" aria-pressed="false" title="Toggle power-flow arrows independently"><span aria-hidden="true">⇢</span><span class="v3-dock-label">Power flow</span></button>' +
        '<button class="v3-dock-btn" id="v3-layers" aria-expanded="false" title="Labels and engineering overlays"><span aria-hidden="true">▱</span><span class="v3-dock-label">Layers</span></button>' +
        "</nav>" +
        '<div id="v3-layer-menu" hidden role="menu">' +
        '<button class="v3-layer-choice" data-target="t-labels" aria-pressed="true"><span>Equipment labels</span><b>ON</b></button>' +
        '<button class="v3-layer-choice" data-target="t-clear" aria-pressed="false"><span>Safety clearances</span><b>OFF</b></button>' +
        '<button class="v3-layer-choice" data-target="t-grid" aria-pressed="false"><span>Ground grid</span><b>OFF</b></button>' +
        '<button class="v3-layer-choice" data-legend="true" aria-pressed="false"><span>Status legend</span><b>SHOW</b></button>' +
        '<button class="v3-layer-choice" data-target="t-reset" data-reset-simulation="true"><span>Reset entire simulator</span><b>RESET</b></button>' +
        "</div>"
    );

    document.body.insertAdjacentHTML(
      "beforeend",
      '<aside id="v3-activity" aria-label="Operator activity and alarm console">' +
        '<div class="v3-activity-head">' +
          '<div class="v3-activity-title"><b>Operator activity</b><span id="v3-activity-subtitle">EMS event and alarm console</span></div>' +
          '<div class="v3-alarm-summary">' +
            '<span class="v3-alarm-chip"><strong id="v3-active-count">0</strong>active</span>' +
            '<span class="v3-alarm-chip unack"><strong id="v3-unack-count">0</strong>unack</span>' +
          "</div>" +
          '<button class="v3-header-btn" id="v3-activity-close" title="Hide activity panel" aria-label="Hide activity panel">×</button>' +
        "</div>" +
        '<div id="v3-activity-tabs" role="tablist">' +
          '<button class="v3-tab" data-tab="equipment" role="tab" aria-selected="false">Equipment</button>' +
          '<button class="v3-tab" data-tab="events" role="tab" aria-selected="true">Events</button>' +
          '<button class="v3-tab" data-tab="alarms" role="tab" aria-selected="false">Alarms</button>' +
          '<button class="v3-tab" data-tab="actions" role="tab" aria-selected="false">Actions</button>' +
          '<button class="v3-tab" data-tab="explain" role="tab" aria-selected="false">Explain</button>' +
        "</div>" +
        '<div class="v3-activity-tools" id="v3-activity-tools">' +
          '<input class="v3-search" id="v3-activity-search" type="search" placeholder="Filter events or alarms…" aria-label="Filter events or alarms">' +
          '<select class="v3-mini-select" id="v3-priority-filter" aria-label="Alarm priority"><option value="all">All priorities</option><option>Critical</option><option>High</option><option>Medium</option><option>Advisory</option></select>' +
          '<select class="v3-mini-select" id="v3-sort" aria-label="Sort order"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="priority">Priority</option></select>' +
          '<button class="v3-mini-btn" id="v3-ack-all" title="Acknowledge all active alarms">Ack all</button>' +
          '<button class="v3-mini-btn" id="v3-clear-returned" title="Clear alarms whose condition has returned to normal">Clear</button>' +
        "</div>" +
        '<div id="v3-activity-body">' +
          '<section class="v3-pane" id="v3-equipment-pane" data-pane="equipment"><div class="v3-empty" id="v3-equipment-empty"><div><b>No equipment selected</b>Click equipment in the 3D yard or use the equipment finder to open live operating details.</div></div></section>' +
          '<section class="v3-pane active" data-pane="events"><div class="v3-list" id="v3-event-list"></div></section>' +
          '<section class="v3-pane" data-pane="alarms"><div class="v3-list" id="v3-alarm-list"></div></section>' +
          '<section class="v3-pane" data-pane="actions"><div class="v3-list" id="v3-action-list"></div></section>' +
          '<section class="v3-pane" data-pane="explain"><div id="v3-explain-wrap"></div></section>' +
        "</div>" +
      "</aside>"
    );

    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="v3-finder" hidden>' +
        '<div class="v3-finder-card" role="dialog" aria-modal="true" aria-labelledby="v3-finder-title">' +
          '<div class="v3-finder-head">' +
            '<input id="v3-finder-input" type="search" autocomplete="off" placeholder="Search transformers, breakers, buses, feeders, relays…" aria-label="Search equipment">' +
            '<button id="v3-finder-close" aria-label="Close equipment finder">×</button>' +
          "</div>" +
          '<div id="v3-finder-filters" aria-label="Equipment categories"></div>' +
          '<div id="v3-finder-list"></div>' +
        "</div>" +
      "</div>"
    );

    const info = $("#info");
    const equipmentPane = $("#v3-equipment-pane");
    if (info && equipmentPane) equipmentPane.appendChild(info);
    const body = info && $(".np-body", info);
    if (body) {
      body.insertAdjacentHTML("afterbegin", '<div id="v3-live-detail"></div>');
    }
    const statusKey = $("#skey");
    if (statusKey) {
      if (innerWidth > 900) statusKey.classList.add("v3-key-open");
      statusKey.insertAdjacentHTML(
        "beforeend",
        '<span><i style="background:#43D7F3"></i>selected equipment</span>' +
          '<span><i style="background:#FF4D5F"></i>closed / critical</span>' +
          '<span><i style="background:#42DC8A"></i>open / safe</span>' +
          '<span><i style="background:#FF7A3D"></i>high alarm</span>' +
          '<span><i style="background:#6C9CFF"></i>advisory</span>'
      );
    }
  }

  function setActivityOpen(open) {
    document.body.classList.toggle("v3-activity-collapsed", !open);
    const toggle = $("#v3-activity-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(open));
    if (open && innerWidth <= 900) {
      const ops = $("#ops");
      if (ops) ops.classList.remove("up");
    }
  }

  function setTab(tab) {
    ui.tab = tab;
    $$(".v3-tab").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    });
    $$(".v3-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.pane === tab);
    });
    const tools = $("#v3-activity-tools");
    if (tools) tools.style.display = /events|alarms|actions/.test(tab) ? "flex" : "none";
    const priority = $("#v3-priority-filter");
    const ack = $("#v3-ack-all");
    const clear = $("#v3-clear-returned");
    if (priority) priority.style.display = tab === "alarms" ? "" : "none";
    if (ack) ack.style.display = tab === "alarms" ? "" : "none";
    if (clear) clear.style.display = tab === "alarms" ? "" : "none";
    setActivityOpen(true);
    renderCurrentPane();
  }

  function eventMatches(event, query) {
    if (!query) return true;
    const haystack = [
      event.equipment,
      event.operation,
      event.source,
      event.effect,
      event.previous,
      event.next,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  function sortedItems(items) {
    const sort = ($("#v3-sort") && $("#v3-sort").value) || "newest";
    const priorityRank = { Critical: 0, High: 1, Medium: 2, Advisory: 3 };
    return items.slice().sort((a, b) => {
      if (sort === "oldest") return a.at - b.at;
      if (sort === "priority") {
        return (
          (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) ||
          b.at - a.at
        );
      }
      return b.at - a.at;
    });
  }

  function eventMarkup(event) {
    const statusClass = event.success
      ? event.priority === "High" || event.priority === "Critical"
        ? "warning"
        : "success"
      : "failed";
    return (
      '<article class="v3-event ' +
      statusClass +
      '" data-event="' +
      esc(event.id) +
      '" tabindex="0">' +
      '<div class="v3-event-meta"><time>' +
      esc(nowTime(event.at)) +
      '</time><span class="v3-priority ' +
      priorityClass(event.priority) +
      '">' +
      esc(event.priority) +
      "</span><span>" +
      esc(event.source) +
      "</span></div>" +
      "<h4>" +
      esc(event.equipment + " — " + event.operation) +
      "</h4>" +
      "<p>" +
      esc(event.effect) +
      "</p>" +
      "</article>"
    );
  }

  function renderEvents(targetId, actionOnly) {
    const target = $("#" + targetId);
    if (!target) return;
    const query = (($("#v3-activity-search") || {}).value || "").trim().toLowerCase();
    let rows = events.filter((event) => (!actionOnly || event.kind === "action"));
    rows = rows.filter((event) => eventMatches(event, query));
    target.innerHTML = rows.length
      ? sortedItems(rows).map(eventMarkup).join("")
      : '<div class="v3-empty"><div><b>No matching records</b>Change the filter or perform an operator action.</div></div>';
    $$("[data-event]", target).forEach((row) => {
      const open = () => {
        ui.selectedEvent = events.find((event) => event.id === row.dataset.event) || null;
        setTab("explain");
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open();
      });
    });
  }

  function alarmMarkup(alarm) {
    return (
      '<article class="v3-alarm-row ' +
      priorityClass(alarm.priority) +
      '" data-alarm="' +
      esc(alarm.id) +
      '">' +
      '<div class="v3-alarm-meta"><time>' +
      esc(nowTime(alarm.raisedAt)) +
      '</time><span class="v3-priority ' +
      priorityClass(alarm.priority) +
      '">' +
      esc(alarm.priority) +
      "</span><span>" +
      (alarm.active
        ? alarm.acknowledged
          ? "ACTIVE · ACK"
          : "ACTIVE · UNACK"
        : "RETURNED") +
      "</span></div>" +
      "<h4>" +
      esc(alarm.equipment + " — " + alarm.title) +
      "</h4>" +
      "<p>" +
      esc(alarm.message) +
      "</p>" +
      '<div class="v3-alarm-actions">' +
      (alarm.active && !alarm.acknowledged
        ? '<button data-ack="' + esc(alarm.id) + '">Acknowledge</button>'
        : "") +
      (!alarm.active
        ? '<span class="v3-returned">Condition returned · eligible to clear</span>'
        : "") +
      "</div>" +
      "</article>"
    );
  }

  function renderAlarms() {
    const target = $("#v3-alarm-list");
    if (!target) return;
    const query = (($("#v3-activity-search") || {}).value || "").trim().toLowerCase();
    const priority = (($("#v3-priority-filter") || {}).value || "all").toLowerCase();
    let rows = Array.from(alarms.values()).filter((alarm) => {
      const matchPriority = priority === "all" || alarm.priority.toLowerCase() === priority;
      const matchQuery = [alarm.equipment, alarm.title, alarm.message]
        .join(" ")
        .toLowerCase()
        .includes(query);
      return matchPriority && matchQuery;
    });
    const priorityRank = { Critical: 0, High: 1, Medium: 2, Advisory: 3 };
    const sort = (($("#v3-sort") || {}).value || "newest");
    rows.sort((a, b) => {
      if (sort === "oldest") return a.raisedAt - b.raisedAt;
      if (sort === "priority") {
        return (
          priorityRank[a.priority] - priorityRank[b.priority] ||
          Number(b.active) - Number(a.active) ||
          b.raisedAt - a.raisedAt
        );
      }
      return Number(b.active) - Number(a.active) || b.raisedAt - a.raisedAt;
    });
    target.innerHTML = rows.length
      ? rows.map(alarmMarkup).join("")
      : '<div class="v3-empty"><div><b>No matching alarms</b>The network is normal or the current filters exclude all records.</div></div>';
    $$("[data-ack]", target).forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        acknowledgeAlarm(button.dataset.ack);
      });
    });
  }

  function acknowledgeAlarm(id) {
    const alarm = alarms.get(id);
    if (!alarm || alarm.acknowledged) return;
    alarm.acknowledged = true;
    alarm.acknowledgedAt = new Date();
    addEvent({
      kind: "action",
      priority: "Advisory",
      equipment: alarm.equipment,
      operation: "Alarm acknowledged",
      previous: "UNACKNOWLEDGED",
      next: "ACKNOWLEDGED",
      source: "Operator / HMI",
      success: true,
      effect:
        "The alarm remains active until its underlying condition returns to normal; acknowledgement records that an operator has reviewed it.",
    });
    renderAll();
  }

  function renderExplanation() {
    const target = $("#v3-explain-wrap");
    if (!target) return;
    const event = ui.selectedEvent || events[0];
    if (!event) {
      target.innerHTML =
        '<div class="v3-empty"><div><b>No operation selected</b>Select an event or operator action to see its system explanation.</div></div>';
      return;
    }
    const explanation = event.explanation || defaultExplanation(event);
    const steps = [
      ["Command", explanation.command],
      ["Equipment state", explanation.equipment],
      ["Power-flow consequence", explanation.power],
      ["Customers and assets", explanation.affected],
      ["Alarm and risk", explanation.alarm],
      ["Verify next", explanation.verify],
    ];
    target.innerHTML =
      '<div class="v3-explain-card"><h3>' +
      esc(event.equipment + " · " + event.operation) +
      "</h3>" +
      steps
        .map(
          (step, index) =>
            '<div class="v3-explain-step"><i>' +
            (index + 1) +
            "</i><div><b>" +
            esc(step[0]) +
            "</b><p>" +
            esc(step[1]) +
            "</p></div></div>"
        )
        .join("") +
      '</div><div class="v3-explain-card"><h3>Live station one-line</h3><div id="v3-oneline"></div></div>';
    renderOneLine();
  }

  function renderCurrentPane() {
    if (ui.tab === "events") renderEvents("v3-event-list", false);
    if (ui.tab === "actions") renderEvents("v3-action-list", true);
    if (ui.tab === "alarms") renderAlarms();
    if (ui.tab === "explain") renderExplanation();
    updateSummary();
  }

  function renderAll() {
    renderEvents("v3-event-list", false);
    renderEvents("v3-action-list", true);
    renderAlarms();
    if (ui.tab === "explain") renderExplanation();
    if (ui.selectedComp) renderEquipmentDetail(ui.selectedComp, ui.selectedDevice);
    updateSummary();
  }

  function updateSummary() {
    const state = snapshot();
    const active = activeAlarms();
    const unack = active.filter((alarm) => !alarm.acknowledged);
    const activeEl = $("#v3-active-count");
    const unackEl = $("#v3-unack-count");
    const headerCount = $("#v3-header-alarm-count");
    if (activeEl) activeEl.textContent = active.length;
    if (unackEl) unackEl.textContent = unack.length;
    if (headerCount) headerCount.textContent = unack.length;
    const health = $("#v3-station-health");
    if (health) {
      health.className =
        "v3-health " +
        (active.some((alarm) => alarm.priority === "Critical")
          ? "alarm"
          : active.length
            ? "warn"
            : "");
      health.textContent = state.customersOut
        ? state.customersOut + " customers out"
        : active.length
          ? active.length + " active alarm" + (active.length === 1 ? "" : "s")
          : "Station normal";
    }
    const subtitle = $("#v3-activity-subtitle");
    if (subtitle) {
      subtitle.textContent =
        state.netMW.toFixed(1) +
        " MW net · " +
        state.customersServed.toLocaleString() +
        " customers served";
    }
  }

  function feederIndexFor(device) {
    if (!device) return null;
    let match = /(?:52|89)-F(\d)/.exec(device.id);
    if (match) return Number(match[1]) - 1;
    match = /(?:SW)-(\d)-/.exec(device.id);
    if (match) return Number(match[1]) - 1;
    if (device.id === "R-F3") return 2;
    const endpoint = [device.a, device.b, device.node]
      .filter(Boolean)
      .find((node) => /^(FD|NB)\d/.test(node));
    if (endpoint) return Number(endpoint.match(/\d/)[0]);
    return null;
  }

  function transformerIndexFor(device, compId) {
    if (device && /(?:^|-)T1(?:$|-)/.test(device.id)) return 0;
    if (device && /(?:^|-)T2(?:$|-)/.test(device.id)) return 1;
    if (/xfmr|bushing|radiator|conservator|oltc/.test(compId || "")) return -1;
    return null;
  }

  function powerMetrics(device, compId) {
    const state = snapshot();
    let p = state.netMW;
    let current = state.netMW
      ? Math.abs(state.netMW) * 1e6 / (Math.sqrt(3) * 34500)
      : 0;
    let label = "Station";
    const feederIndex = feederIndexFor(device);
    if (feederIndex != null && state.fs[feederIndex]) {
      const feeder = state.fs[feederIndex];
      p = feeder.net;
      current = feeder.amps;
      label = "Feeder " + (feederIndex + 1);
    } else if (device && /T1/.test(device.id)) {
      p = N.ST.mva1 * 0.96;
      current = Math.abs(p) * 1e6 / (Math.sqrt(3) * 34500);
      label = "Transformer T1";
    } else if (device && /T2/.test(device.id)) {
      p = N.ST.mva2 * 0.96;
      current = Math.abs(p) * 1e6 / (Math.sqrt(3) * 34500);
      label = "Transformer T2";
    } else if (/xfmr/.test(compId || "")) {
      p = (N.ST.mva1 + N.ST.mva2) * 0.96;
      current = Math.abs(p) * 1e6 / (Math.sqrt(3) * 34500);
      label = "Transformers";
    }
    const pf = p < -0.02 ? -0.97 : 0.97;
    const q = Math.abs(p) * Math.tan(Math.acos(Math.abs(pf)));
    return { p, q, current, pf, label };
  }

  function relatedRelays(device) {
    if (!device) return [];
    const feeder = feederIndexFor(device);
    return X.RLY.filter((relay) => {
      if (feeder != null && relay.fdr === feeder) return true;
      return [device.a, device.b, device.node].filter(Boolean).includes(relay.zone);
    });
  }

  function renderEquipmentDetail(compId, deviceId) {
    const comp = COMP[compId];
    if (!comp) return;
    let device = deviceId ? N.DEV[deviceId] : null;
    const matches = Object.values(N.DEV).filter((item) => item.comp === compId);
    if (!device && matches.length === 1) device = matches[0];
    const energy = device ? deviceEnergy(device) : componentEnergy(compId);
    const metrics = powerMetrics(device, compId);
    const relayList = relatedRelays(device);
    const connected = device
      ? device.kind === "gnd"
        ? device.node
        : [device.a, device.b].filter(Boolean).join(" ↔ ")
      : "See station one-line";
    const relevantAlarms = activeAlarms().filter((alarm) => {
      const scope = alarm.scope || {};
      const feeder = feederIndexFor(device);
      const transformer = transformerIndexFor(device, compId);
      if (
        device &&
        Array.isArray(scope.deviceIds) &&
        scope.deviceIds.includes(device.id)
      ) {
        return true;
      }
      if (feeder != null && scope.feeder === feeder) return true;
      if (
        transformer != null &&
        scope.transformer != null &&
        (transformer === -1 || scope.transformer === transformer)
      ) {
        return true;
      }
      const text = (alarm.equipment + " " + alarm.message).toLowerCase();
      return (
        text.includes((device ? device.id : comp.tag || comp.name).toLowerCase()) ||
        (feeder != null && text.includes("feeder " + (feeder + 1)))
      );
    });

    if (device) {
      $("#i-tag").textContent = device.id;
      $("#i-name").textContent = device.name.replace(device.id, "").trim() || comp.name;
    }
    const liveDetail = $("#v3-live-detail");
    if (liveDetail) {
      const statusPills = [
        '<span class="v3-state-pill ' +
          energy.cls +
          '">' +
          energy.label +
          "</span>",
      ];
      if (device) {
        statusPills.unshift(
          '<span class="v3-state-pill ' +
            (device.closed ? "closed" : "open") +
            '">' +
            (device.closed ? "Closed" : "Open") +
            "</span>"
        );
      }
      statusPills.push(
        '<span class="v3-state-pill ' +
          (relevantAlarms.length ? "warning" : "normal") +
          '">' +
          (relevantAlarms.length ? relevantAlarms.length + " active alarm" : "Normal") +
          "</span>"
      );
      if (energy.oos) {
        statusPills.push('<span class="v3-state-pill oos">Out of service</span>');
      }
      const metricRows = [
        ["Type", typeFor(device, compId)],
        ["Voltage", comp.volt || "—"],
        ["Current", Math.round(metrics.current) + " A"],
        ["Active power", metrics.p.toFixed(1) + " MW"],
        ["Reactive power", metrics.q.toFixed(1) + " MVAR"],
        ["Power factor", Math.abs(metrics.pf).toFixed(2) + (metrics.pf < 0 ? " export" : " lag")],
        ["Connected", connected],
        ["Protection", relayList.length ? relayList.map((relay) => relay.id).join(", ") : "Local / upstream"],
        ["Operations", device ? String(device.ops || 0) : "—"],
      ];
      liveDetail.innerHTML =
        '<div class="v3-detail-status">' +
        statusPills.join("") +
        '</div><div class="v3-metrics">' +
        metricRows
          .map(
            (row) =>
              '<div class="v3-metric"><span>' +
              esc(row[0]) +
              "</span><b title=\"" +
              esc(row[1]) +
              '">' +
              esc(row[1]) +
              "</b></div>"
          )
          .join("") +
        "</div>";
    }
    const operationButtons = $$("#i-ops [data-d]");
    operationButtons.forEach((button) => {
      button.style.display =
        !device || button.dataset.d === device.id ? "" : "none";
    });
    $$("#i-state > div").forEach((row) => {
      row.style.display =
        !device || row.textContent.trim().startsWith(device.id + " ") ? "" : "none";
    });
    const empty = $("#v3-equipment-empty");
    if (empty) empty.style.display = "none";
    const focus = $("#v3-focus");
    if (focus) focus.disabled = false;
  }

  function wrapSelection() {
    const priorSelect = window.select;
    if (typeof priorSelect !== "function") return;
    window.select = function (compId, fly) {
      const picked = window.__PICKED_DEVICE || ui.requestedDevice || null;
      const shouldOpen = !!window.__PICKED_DEVICE || ui.openOnSelect;
      window.__PICKED_DEVICE = null;
      ui.requestedDevice = null;
      ui.openOnSelect = false;
      ui.selectedComp = compId;
      ui.selectedDevice = picked;
      priorSelect(compId, fly);
      renderEquipmentDetail(compId, picked);
      if (shouldOpen) setTab("equipment");
    };

    const priorCloseInfo = window.closeInfo;
    window.closeInfo = function () {
      if (typeof priorCloseInfo === "function") priorCloseInfo();
      ui.selectedComp = null;
      ui.selectedDevice = null;
      ui.requestedDevice = null;
      ui.openOnSelect = false;
      const focus = $("#v3-focus");
      if (focus) focus.disabled = true;
      const empty = $("#v3-equipment-empty");
      if (empty) empty.style.display = "";
      if (ui.tab === "equipment") {
        setTab("events");
        if (innerWidth <= 900) setActivityOpen(false);
      }
    };

    const close = $("#closeinfo");
    if (close) {
      close.onclick = window.closeInfo;
    }
  }

  function renderOneLine() {
    const target = $("#v3-oneline");
    if (!target) return;
    const state = snapshot();
    const nodes = [
      [
        { id: "52-L1", label: "Line 1", sub: N.isLive("TL1") ? "230 kV live" : "de-energized", live: N.isLive("TL1"), comp: "cb_hv" },
        { id: "52-L2", label: "Line 2", sub: N.isLive("TL2") ? "230 kV live" : "de-energized", live: N.isLive("TL2"), comp: "cb_hv" },
      ],
      [
        { id: "BUSA", label: "Bus A", sub: N.isLive("BUSA") ? "energized" : "dead", live: N.isLive("BUSA"), comp: "busA" },
        { id: "BUSB", label: "Bus B", sub: N.isLive("BUSB") ? "energized" : "dead", live: N.isLive("BUSB"), comp: "busB" },
      ],
      [
        { id: "52-T1", label: "T1", sub: state.t1Pct + "% · " + N.ST.mva1.toFixed(1) + " MVA", live: N.isLive("XF1S"), warning: state.t1Pct > 85, alarm: state.t1Pct > 100, comp: "xfmr" },
        { id: "52-T2", label: "T2", sub: state.t2Pct + "% · " + N.ST.mva2.toFixed(1) + " MVA", live: N.isLive("XF2S"), warning: state.t2Pct > 85, alarm: state.t2Pct > 100, comp: "xfmr" },
      ],
      state.fs.map((feeder) => ({
        id: "52-F" + (feeder.i + 1),
        label: "Feeder " + (feeder.i + 1),
        sub:
          Math.round(feeder.amps) +
          " A · " +
          (feeder.outCust ? feeder.outCust + " out" : feeder.rev ? "export" : "normal"),
        live: feeder.live,
        reverse: feeder.rev,
        warning: feeder.rate > 0.85,
        alarm: feeder.rate > 1 || feeder.outCust > 0,
        comp: "fdr_cb",
      })),
    ];
    target.innerHTML = nodes
      .map(
        (row) =>
          '<div class="v3-one-row ' +
          (row.length === 2 ? "two" : "") +
          '">' +
          row
            .map((node) => {
              const cls = node.alarm
                ? "alarm"
                : node.warning
                  ? "warning"
                  : node.reverse
                    ? "reverse"
                    : node.live
                      ? "live"
                      : "dead";
              return (
                '<button class="v3-one-node ' +
                cls +
                '" data-device="' +
                esc(node.id) +
                '" data-comp="' +
                esc(node.comp) +
                '"><b>' +
                esc(node.label) +
                "</b><span>" +
                esc(node.sub) +
                "</span></button>"
              );
            })
            .join("") +
          "</div>"
      )
      .join("");
    $$("[data-device]", target).forEach((button) => {
      button.addEventListener("click", () => selectDevice(button.dataset.device, button.dataset.comp));
    });
  }

  function groupFor(record) {
    const text = (record.type + " " + record.name + " " + record.comp).toLowerCase();
    if (/breaker|disconnect|switch|recloser|tie|earth/.test(text)) return "switching";
    if (/transform|oltc|regulator/.test(text)) return "transformers";
    if (/relay|scada|battery|control/.test(text)) return "protection";
    if (/line|bus|feeder|tower/.test(text)) return "network";
    if (/solar|generation|generator|der/.test(text)) return "generation";
    return "other";
  }

  function equipmentCatalog() {
    const records = [];
    const represented = new Set();
    Object.values(N.DEV).forEach((device) => {
      represented.add(device.comp);
      records.push({
        id: device.id,
        deviceId: device.id,
        comp: device.comp,
        name: device.name.replace(device.id, "").trim() || device.name,
        tag: device.id,
        type: typeFor(device, device.comp),
        voltage: (COMP[device.comp] && COMP[device.comp].volt) || "",
      });
    });
    Object.keys(COMP).forEach((compId) => {
      if (represented.has(compId)) return;
      const comp = COMP[compId];
      records.push({
        id: "comp-" + compId,
        deviceId: null,
        comp: compId,
        name: comp.name,
        tag: comp.tag,
        type: typeFor(null, compId),
        voltage: comp.volt || "",
      });
    });
    records.forEach((record) => {
      record.group = groupFor(record);
    });
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  const catalog = equipmentCatalog();
  const groupLabels = {
    all: "All",
    switching: "Switching",
    transformers: "Transformers",
    network: "Lines & buses",
    protection: "Protection",
    generation: "Generation & DER",
    other: "Other",
  };

  function iconFor(record) {
    if (record.group === "switching") return record.type.includes("Earthing") ? "⏚" : "▯";
    if (record.group === "transformers") return "⌁";
    if (record.group === "network") return "═";
    if (record.group === "protection") return "R";
    if (record.group === "generation") return "∿";
    return "◇";
  }

  function equipmentState(record) {
    if (!record.deviceId) return { text: "Available", cls: "live" };
    const device = N.DEV[record.deviceId];
    if (!device) return { text: "Available", cls: "live" };
    if (!device.closed) return { text: "Open", cls: "open" };
    return { text: deviceLive(device) ? "Live" : "Closed", cls: "live" };
  }

  function renderFinder() {
    const filters = $("#v3-finder-filters");
    if (filters && !filters.children.length) {
      filters.innerHTML = Object.keys(groupLabels)
        .map(
          (group) =>
            '<button class="v3-filter-chip" data-group="' +
            group +
            '" aria-pressed="' +
            (group === ui.equipmentFilter) +
            '">' +
            groupLabels[group] +
            "</button>"
        )
        .join("");
      $$(".v3-filter-chip", filters).forEach((button) => {
        button.addEventListener("click", () => {
          ui.equipmentFilter = button.dataset.group;
          $$(".v3-filter-chip", filters).forEach((item) =>
            item.setAttribute("aria-pressed", String(item === button))
          );
          renderFinder();
        });
      });
    }
    const query = (($("#v3-finder-input") || {}).value || "").trim().toLowerCase();
    const rows = catalog.filter((record) => {
      const groupMatch = ui.equipmentFilter === "all" || record.group === ui.equipmentFilter;
      const queryMatch = [record.name, record.tag, record.type, record.voltage]
        .join(" ")
        .toLowerCase()
        .includes(query);
      return groupMatch && queryMatch;
    });
    const list = $("#v3-finder-list");
    if (!list) return;
    list.innerHTML = rows.length
      ? rows
          .map((record) => {
            const state = equipmentState(record);
            return (
              '<button class="v3-equipment-row" data-record="' +
              esc(record.id) +
              '">' +
              '<span class="v3-equipment-icon" aria-hidden="true">' +
              esc(iconFor(record)) +
              '</span><span class="v3-equipment-copy"><b>' +
              esc(record.name) +
              "</b><span>" +
              esc(record.tag + " · " + record.type + (record.voltage ? " · " + record.voltage : "")) +
              '</span></span><span class="v3-equipment-state ' +
              state.cls +
              '">' +
              esc(state.text) +
              "</span></button>"
            );
          })
          .join("")
      : '<div class="v3-empty"><div><b>No equipment found</b>Try a device ID, equipment type, voltage, or feeder number.</div></div>';
    $$("[data-record]", list).forEach((button) => {
      button.addEventListener("click", () => {
        const record = catalog.find((item) => item.id === button.dataset.record);
        if (!record) return;
        closeFinder();
        if (record.deviceId) selectDevice(record.deviceId, record.comp);
        else {
          ui.openOnSelect = true;
          window.select(record.comp, true);
        }
      });
    });
  }

  function openFinder() {
    const finder = $("#v3-finder");
    if (!finder) return;
    finder.hidden = false;
    renderFinder();
    requestAnimationFrame(() => $("#v3-finder-input").focus());
  }

  function closeFinder() {
    const finder = $("#v3-finder");
    if (finder) finder.hidden = true;
  }

  function selectDevice(deviceId, fallbackComp) {
    const device = N.DEV[deviceId];
    ui.requestedDevice = device ? device.id : null;
    ui.openOnSelect = true;
    window.select(device ? device.comp : fallbackComp, true);
  }

  function focusSelected() {
    if (!ui.selectedComp) return;
    const device = ui.selectedDevice && N.DEV[ui.selectedDevice];
    const roots = device && device.obj ? [device.obj] : REG[ui.selectedComp] || [];
    if (!roots.length) {
      const comp = COMP[ui.selectedComp];
      if (comp && comp.view) flyTo(comp.view);
      return;
    }
    const box = new THREE.Box3();
    roots.forEach((root) => box.expandByObject(root));
    if (box.isEmpty()) return;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const radius = Math.max(6, sphere.radius * 3.1);
    flyTo({
      t: [sphere.center.x, sphere.center.y, sphere.center.z],
      r: radius,
      th: CAM.gth,
      ph: Math.max(0.55, CAM.gph),
    });
  }

  function setPowerFlow(enabled) {
    ui.powerFlow = !!enabled;
    prefs.powerFlow = ui.powerFlow;
    savePrefs();
    const groups = N.flowGroups || {};
    if (groups.base) groups.base.visible = ui.powerFlow;
    if (groups.reversible) groups.reversible.visible = ui.powerFlow;
    const button = $("#v3-flow");
    if (button) button.setAttribute("aria-pressed", String(ui.powerFlow));
    updateFlowMagnitude();
  }

  function updateFlowMagnitude() {
    const groups = N.flowGroups || {};
    if (!ui.powerFlow) {
      if (groups.base) groups.base.visible = false;
      if (groups.reversible) groups.reversible.visible = false;
      return;
    }
    if (groups.base) groups.base.visible = true;
    if (groups.reversible) groups.reversible.visible = true;
    const state = snapshot();
    N.F2.forEach((record) => {
      const section = (N.ST.sections || []).find((item) => item.node === record.node);
      const feeder = record.f != null ? state.fs[record.f] : null;
      const magnitude = section
        ? Math.abs(section.net)
        : feeder
          ? Math.abs(feeder.net)
          : Math.abs(state.netMW) / 4;
      const scale = 0.68 + Math.min(0.82, magnitude / 16);
      record.arr.forEach((arrow) => {
        if (arrow.userData.v3BaseScale == null) {
          arrow.userData.v3BaseScale = arrow.scale.x || 1;
        }
        arrow.scale.setScalar(arrow.userData.v3BaseScale * scale);
        arrow.visible = N.isLive(record.node);
      });
    });
  }

  function collisionPass() {
    const labels = $$(".lbl");
    labels.forEach((label) => label.classList.remove("v3-occluded"));
    const blockers = [$("#ops"), document.body.classList.contains("v3-activity-collapsed") ? null : $("#v3-activity"), $("#board")]
      .filter(Boolean)
      .map((element) => element.getBoundingClientRect());
    const visible = labels
      .filter((label) => !label.classList.contains("hide") && getComputedStyle(label).display !== "none")
      .sort((a, b) => {
        const aScore = a.textContent.includes((COMP[ui.selectedComp] || {}).name || "~~~~") ? 3 : a.classList.contains("major") ? 2 : 1;
        const bScore = b.textContent.includes((COMP[ui.selectedComp] || {}).name || "~~~~") ? 3 : b.classList.contains("major") ? 2 : 1;
        return bScore - aScore;
      });
    const occupied = [];
    visible.forEach((label) => {
      const rect = label.getBoundingClientRect();
      const outside =
        rect.left < 6 ||
        rect.right > innerWidth - 6 ||
        rect.top < 6 ||
        rect.bottom > innerHeight - 6;
      const blocked = blockers.some(
        (box) =>
          rect.left < box.right &&
          rect.right > box.left &&
          rect.top < box.bottom &&
          rect.bottom > box.top
      );
      const overlaps = occupied.some(
        (box) =>
          rect.left < box.right + 5 &&
          rect.right > box.left - 5 &&
          rect.top < box.bottom + 4 &&
          rect.bottom > box.top - 4
      );
      if (outside || blocked || overlaps) label.classList.add("v3-occluded");
      else occupied.push(rect);
    });
  }

  function recordBatchTransition(before, after, kind) {
    const customerDelta = after.customersOut - before.customersOut;
    const loadDelta = after.netMW - before.netMW;
    const overload = after.fs.find((feeder) => feeder.rate > 1);
    const isScenario = kind === "scenario";
    const equipment = isScenario
      ? after.scenarioName || before.scenarioName || "Training scenario"
      : "SEL-3530 RTAC / FISR";
    const step = isScenario ? after.scenarioStep : after.fisrStep;
    const operation = isScenario
      ? after.scenarioName
        ? "Scenario step " + (step + 1) + " applied"
        : "Scenario ended; normal configuration restored"
      : after.fisrActive
        ? "FISR sequence step " + (step + 1) + " applied"
        : "FISR sequence cleared";
    addEvent({
      kind: "action",
      priority:
        after.fault != null || after.faultSec || overload
          ? "Critical"
          : customerDelta > 0
            ? "High"
            : customerDelta < 0
              ? "Advisory"
              : "Medium",
      equipment,
      operation,
      previous:
        before.customersServed.toLocaleString() +
        " served / " +
        before.netMW.toFixed(1) +
        " MW",
      next:
        after.customersServed.toLocaleString() +
        " served / " +
        after.netMW.toFixed(1) +
        " MW",
      source: isScenario ? "Training scenario" : "SEL-3530 RTAC / FISR",
      success: true,
      effect:
        (customerDelta > 0
          ? customerDelta + " customers were interrupted"
          : customerDelta < 0
            ? Math.abs(customerDelta) + " customers were restored"
            : "Customer supply was unchanged") +
        "; net station demand moved " +
        Math.abs(loadDelta).toFixed(1) +
        " MW " +
        (loadDelta < 0 ? "down" : loadDelta > 0 ? "up" : "with no material change") +
        ". All switching changes in this automation step are correlated in this single record.",
    });
  }

  function recordAnalogueTransitions(before, after) {
    const source = O.SCEN && O.SCEN.active ? "Training scenario" : "Operator / HMI";
    if (Math.abs(after.sun - before.sun) > 0.0001) {
      addEvent({
        kind: "action",
        priority: "Advisory",
        equipment: "Distributed energy resources",
        operation: "Irradiance changed",
        previous: Math.round(before.sun * 100) + "%",
        next: Math.round(after.sun * 100) + "%",
        source,
        success: true,
        effect:
          "Solar generation, reverse-power direction, feeder current and transformer loading were recalculated.",
      });
    }
    [
      ["T1", before.tapT1, after.tapT1],
      ["T2", before.tapT2, after.tapT2],
    ].forEach(([name, prior, next]) => {
      if (prior === next || prior == null || next == null) return;
      addEvent({
        kind: "action",
        priority: "Advisory",
        equipment: "Transformer " + name + " OLTC",
        operation: "Tap position changed",
        previous: (prior >= 0 ? "+" : "") + prior,
        next: (next >= 0 ? "+" : "") + next,
        source,
        success: true,
        effect:
          "The transformer ratio and downstream voltage estimate were updated while load remained connected.",
      });
    });
    if (after.shed !== before.shed) {
      addEvent({
        kind: "action",
        priority: after.shed ? "High" : "Advisory",
        equipment: "Underfrequency load-shedding scheme",
        operation: after.shed ? "Load-shed blocks applied" : "Load-shed blocks restored",
        previous: before.shed || "None",
        next: after.shed || "None",
        source,
        success: true,
        effect:
          "The served load model was recalculated for the affected feeders and the station balance was updated.",
      });
    }
  }

  function pollState() {
    const current = snapshot();
    const scenarioChanged =
      current.scenarioName !== previousSnapshot.scenarioName ||
      current.scenarioStep !== previousSnapshot.scenarioStep;
    const fisrChanged =
      current.fisrActive !== previousSnapshot.fisrActive ||
      current.fisrStep !== previousSnapshot.fisrStep;
    const batchTransition = scenarioChanged || fisrChanged;
    let selectedChanged = false;

    Object.values(N.DEV).forEach((device) => {
      const beforeClosed = deviceStates.get(device.id);
      const afterClosed = !!device.closed;
      if (beforeClosed !== afterClosed) {
        if (!batchTransition) {
          recordOperation(
            device,
            beforeClosed,
            afterClosed,
            previousSnapshot,
            current,
            sourceFor(device.id)
          );
        }
        if (ui.selectedDevice === device.id) selectedChanged = true;
        deviceStates.set(device.id, afterClosed);
        if (ui.pendingCommand && ui.pendingCommand.id === device.id) {
          ui.pendingCommand = null;
        }
      }
    });

    if (scenarioChanged) {
      recordBatchTransition(previousSnapshot, current, "scenario");
    } else if (fisrChanged) {
      recordBatchTransition(previousSnapshot, current, "fisr");
    } else {
      recordAnalogueTransitions(previousSnapshot, current);
    }

    X.RLY.forEach((relay) => {
      Object.keys(relay.set).forEach((key) => {
        const mapKey = relay.id + "|" + key;
        const before = relayStates.get(mapKey);
        const after = relay.set[key];
        if (before !== after) {
          addEvent({
            kind: "action",
            priority: key === "Hot-line tag" ? "Medium" : "Advisory",
            equipment: relay.id + " " + relay.m,
            operation: key + " changed",
            previous: String(before),
            next: String(after),
            source: O.SCEN && O.SCEN.active ? "Training scenario" : "Operator / HMI",
            success: true,
            effect:
              key === "Hot-line tag"
                ? after
                  ? "Every close path for the protected circuit is now blocked for crew safety."
                  : "The close block was removed; normal switching permissives still apply."
                : "The live protection setting was updated and will affect subsequent relay or automation behavior.",
          });
          relayStates.set(mapKey, after);
        }
      });
    });

    reconcileAlarms(current);
    previousSnapshot = current;
    updateSummary();
    if (selectedChanged && ui.selectedComp && typeof O.buildDeviceUI === "function") {
      O.buildDeviceUI(ui.selectedComp);
    }
    if (ui.selectedComp) renderEquipmentDetail(ui.selectedComp, ui.selectedDevice);
    if (ui.tab === "explain") renderOneLine();
    updateFlowMagnitude();
  }

  function bindEvents() {
    $$(".v3-tab").forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    });
    $("#v3-activity-close").addEventListener("click", () => setActivityOpen(false));
    $("#v3-activity-toggle").addEventListener("click", () => {
      setActivityOpen(document.body.classList.contains("v3-activity-collapsed"));
    });
    $("#v3-search-open").addEventListener("click", openFinder);
    $("#v3-finder-close").addEventListener("click", closeFinder);
    $("#v3-finder").addEventListener("click", (event) => {
      if (event.target.id === "v3-finder") closeFinder();
    });
    $("#v3-finder-input").addEventListener("input", renderFinder);
    $("#v3-alarm-open").addEventListener("click", () => setTab("alarms"));
    $("#v3-activity-search").addEventListener("input", renderCurrentPane);
    $("#v3-priority-filter").addEventListener("change", renderCurrentPane);
    $("#v3-sort").addEventListener("change", renderCurrentPane);
    $("#v3-ack-all").addEventListener("click", () => {
      activeAlarms().forEach((alarm) => {
        alarm.acknowledged = true;
        alarm.acknowledgedAt = new Date();
      });
      addEvent({
        kind: "action",
        priority: "Advisory",
        equipment: "Alarm console",
        operation: "All active alarms acknowledged",
        previous: "UNACKNOWLEDGED",
        next: "ACKNOWLEDGED",
        source: "Operator / HMI",
        success: true,
        effect:
          "Flashing and audible indications are silenced; every alarm remains active until its initiating condition returns to normal.",
      });
      renderAll();
    });
    $("#v3-clear-returned").addEventListener("click", () => {
      let cleared = 0;
      Array.from(alarms.entries()).forEach(([key, alarm]) => {
        if (!alarm.active) {
          alarms.delete(key);
          cleared += 1;
        }
      });
      addEvent({
        kind: "action",
        priority: "Advisory",
        equipment: "Alarm console",
        operation: "Returned alarms cleared",
        previous: "HISTORY",
        next: "CLEARED",
        source: "Operator / HMI",
        success: true,
        effect:
          cleared +
          " alarm" +
          (cleared === 1 ? " was" : "s were") +
          " cleared. Active conditions were retained.",
      });
      renderAll();
    });

    $("#v3-theme").addEventListener("click", () => {
      const light = !document.body.classList.contains("v3-light");
      document.body.classList.toggle("v3-light", light);
      prefs.theme = light ? "light" : "dark";
      $("#v3-theme").setAttribute("aria-pressed", String(light));
      savePrefs();
    });
    $("#v3-sound").addEventListener("click", () => {
      ui.sound = !ui.sound;
      prefs.sound = ui.sound;
      $("#v3-sound").setAttribute("aria-pressed", String(ui.sound));
      savePrefs();
      if (ui.sound) {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            ui.audio = ui.audio || new AudioCtx();
            if (ui.audio.state === "suspended") ui.audio.resume();
          }
        } catch (_) {}
      }
      addEvent({
        kind: "action",
        priority: "Advisory",
        equipment: "Alarm console",
        operation: "Audible alarm " + (ui.sound ? "enabled" : "disabled"),
        previous: ui.sound ? "OFF" : "ON",
        next: ui.sound ? "ON" : "OFF",
        source: "Operator / HMI",
        success: true,
        effect:
          ui.sound
            ? "New Critical and High alarms will sound two short tones."
            : "Alarm priorities and visual indications remain active without audio.",
      });
    });

    $("#v3-flow").addEventListener("click", () => setPowerFlow(!ui.powerFlow));

    $$("[data-camera]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.camera;
        if (action === "reset") flyTo(VIEWS.overview);
        if (action === "fit") flyTo({ t: [4, 8, 0], r: 184, th: -0.78, ph: 1.01 });
        if (action === "top") flyTo({ t: [8, 0, 0], r: 205, th: -Math.PI / 2, ph: 0.08 });
        if (action === "operator") flyTo(VIEWS.control);
        if (action === "focus") focusSelected();
      });
    });

    const layersButton = $("#v3-layers");
    const layerMenu = $("#v3-layer-menu");
    layersButton.addEventListener("click", () => {
      const open = layerMenu.hidden;
      layerMenu.hidden = !open;
      layersButton.setAttribute("aria-expanded", String(open));
      if (open) {
        const rect = layersButton.getBoundingClientRect();
        layerMenu.style.left = Math.max(8, rect.right - 205) + "px";
        layerMenu.style.top = rect.top - layerMenu.offsetHeight - 8 + "px";
        $$(".v3-layer-choice", layerMenu).forEach((choice) => {
          if (choice.dataset.resetSimulation) return;
          if (choice.dataset.legend) {
            const statusKey = $("#skey");
            const on = !!statusKey && statusKey.classList.contains("v3-key-open");
            choice.setAttribute("aria-pressed", String(on));
            $("b", choice).textContent = on ? "HIDE" : "SHOW";
            return;
          }
          const target = $("#" + choice.dataset.target);
          const on = target && target.getAttribute("aria-pressed") === "true";
          choice.setAttribute("aria-pressed", String(on));
          $("b", choice).textContent = on ? "ON" : "OFF";
        });
      }
    });
    $$(".v3-layer-choice", layerMenu).forEach((choice) => {
      choice.addEventListener("click", () => {
        if (choice.dataset.legend) {
          const statusKey = $("#skey");
          const on = statusKey && statusKey.classList.toggle("v3-key-open");
          choice.setAttribute("aria-pressed", String(!!on));
          $("b", choice).textContent = on ? "HIDE" : "SHOW";
          return;
        }
        const target = $("#" + choice.dataset.target);
        if (target) target.click();
        if (!choice.dataset.resetSimulation) {
          const on = target && target.getAttribute("aria-pressed") === "true";
          choice.setAttribute("aria-pressed", String(on));
          $("b", choice).textContent = on ? "ON" : "OFF";
        } else {
          layerMenu.hidden = true;
          layersButton.setAttribute("aria-expanded", "false");
        }
      });
    });
    document.addEventListener("click", (event) => {
      if (
        !layerMenu.hidden &&
        !layerMenu.contains(event.target) &&
        !layersButton.contains(event.target)
      ) {
        layerMenu.hidden = true;
        layersButton.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("[data-d][data-w]");
        if (!button) return;
        const device = N.DEV[button.dataset.d];
        if (!device) return;
        const want = button.dataset.w === "1";
        const reason = N.checkOperate(device.id, want);
        ui.pendingCommand = {
          id: device.id,
          want,
          before: !!device.closed,
          reason,
          at: performance.now(),
        };
        setTimeout(() => {
          if (
            ui.pendingCommand &&
            ui.pendingCommand.id === device.id &&
            device.closed === ui.pendingCommand.before &&
            device.closed !== want
          ) {
            recordFailedCommand(device, want, reason);
            ui.pendingCommand = null;
          }
        }, 140);
      },
      true
    );

    const legacyAck = $("#ackbtn");
    if (legacyAck) {
      legacyAck.addEventListener("click", () => {
        const unacknowledged = activeAlarms().filter((alarm) => !alarm.acknowledged);
        if (!unacknowledged.length) return;
        unacknowledged.forEach((alarm) => {
          alarm.acknowledged = true;
          alarm.acknowledgedAt = new Date();
        });
        addEvent({
          kind: "action",
          priority: "Advisory",
          equipment: "Alarm console",
          operation: "Active alarms acknowledged",
          previous: unacknowledged.length + " UNACKNOWLEDGED",
          next: "ACKNOWLEDGED",
          source: "Operator / HMI",
          success: true,
          effect:
            "The legacy annunciator and canonical alarm workspace are synchronized; active conditions remain visible until normal.",
        });
        renderAll();
      });
    }

    addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openFinder();
      } else if (event.key === "Escape") {
        if (!$("#v3-finder").hidden) closeFinder();
        else if (!$("#v3-layer-menu").hidden) $("#v3-layer-menu").hidden = true;
      }
    });

    const opsHeader = $("#ops .ops-h");
    if (opsHeader) {
      opsHeader.addEventListener(
        "click",
        () => {
          if (innerWidth <= 900) setActivityOpen(false);
        },
        true
      );
    }

    $$(".mode").forEach((button) => {
      button.addEventListener("click", () => setTimeout(() => setPowerFlow(ui.powerFlow), 0));
    });
  }

  function initialize() {
    buildShell();
    wrapSelection();
    bindEvents();

    if (prefs.theme === "light") {
      document.body.classList.add("v3-light");
      $("#v3-theme").setAttribute("aria-pressed", "true");
    }
    $("#v3-sound").setAttribute("aria-pressed", String(ui.sound));
    if (innerWidth <= 1120) document.body.classList.add("v3-activity-collapsed");
    setPowerFlow(ui.powerFlow);
    setTab("events");
    if (innerWidth <= 1120) setActivityOpen(false);

    addEvent({
      kind: "normal",
      priority: "Advisory",
      equipment: "Kestrel Ridge Substation",
      operation: "Simulator initialized",
      previous: "OFFLINE",
      next: "NORMAL",
      source: "System",
      success: true,
      effect:
        "Both 230 kV lines, two 50 MVA transformers and four distribution feeders are available. The graph-based network model is synchronized with the 3D yard and one-line.",
      explanation: {
        command: "The simulator completed its startup checks and loaded the normal switching configuration.",
        equipment:
          "Both incoming lines, Bus A, Bus B, transformers T1 and T2, and all four feeder sources are available.",
        power:
          "The network solver traced energized paths from the source and calculated feeder load, solar output, transformer loading and current direction.",
        affected:
          previousSnapshot.customersServed.toLocaleString() +
          " customers are supplied; no customer section is out of service.",
        alarm:
          "The alarm processor is active. New faults, outages, overloads, loops and safety earths will be prioritized automatically.",
        verify:
          "Review the live one-line, station MW, transformer loading, feeder current and alarm summary before beginning a training scenario.",
      },
    });
    reconcileAlarms(previousSnapshot);
    renderAll();
    renderFinder();

    setInterval(pollState, 260);
    setInterval(collisionPass, 180);

    window.__SCADA_V3 = {
      events,
      alarms,
      snapshot,
      setTab,
      setActivityOpen,
      setPowerFlow,
      selectDevice,
      openFinder,
      renderAll,
      state: ui,
    };
  }

  initialize();
})();
