// Worker lifecycle for one pool, as Firefox Profiler threads. workers.html loads
// workers-<date>-lifecycle.json and appends these threads to the pool's profile:
// one process per location (all workers, each datacenter, each region, each
// zone), in tree order, each with the same charts and a call tree of the
// locations below it. Every location lists the lanes of the workers below it.
// State colours follow the Taskcluster UI: requested grey, running blue,
// stopping orange, stopped red.
// A classic script, so everything is held in one namespace.
const WorkerLifecycle = (function () {
  const MINUTE_MS = 60 * 1000;
  const INSTANT = 0;
  const INTERVAL = 1;
  const TOP_STOP_REASONS = 6;
  const MIN_BUCKET_MS = 10 * 1000;
  const MAX_BUCKETS = 1440;
  const NO_REASON = 'no reason recorded';
  const UNCLASSIFIED = 'unclassified';
  const OTHER = 'other';
  const NO_CODE = '(no code)';
  const NO_LOCATION = '(no location recorded)';
  const UNKNOWN_WORKER = '(unknown worker)';
  const DATACENTER_ORDER = ['Google Cloud', 'Azure'];

  // What a worker is doing at an instant. "running" in the phases is split into
  // running a task and waiting for one, by joining the tasks the worker claimed.
  const STATES = [
    { key: 'starting', label: 'Starting', category: 'Worker starting', categoryColor: 'grey' },
    { key: 'runningTask', label: 'Running a task', category: 'Worker running a task', categoryColor: 'blue' },
    { key: 'waiting', label: 'Waiting for a task', category: 'Worker waiting', categoryColor: 'lightblue' },
    { key: 'stopping', label: 'Stopping', category: 'Worker stopping', categoryColor: 'orange' },
    { key: 'failedToStart', label: 'Failed to start', category: 'Worker failed to start', categoryColor: 'red' },
  ];
  const LANE_CATEGORY = { name: 'Worker lanes', color: 'green' };
  const ERROR_CATEGORY = { name: 'Worker errors', color: 'red' };
  const PROFILE_CATEGORIES = [
    ...STATES.map(state => ({ name: state.category, color: state.categoryColor })),
    LANE_CATEGORY,
    ERROR_CATEGORY,
  ].map(category => ({ ...category, subcategories: ['Other'] }));

  // The chart bands, bottom to top. Running covers both running a task and waiting.
  const BANDS = [
    { key: 'running', label: 'Running (blue)', color: 'blue', states: ['runningTask', 'waiting'] },
    { key: 'starting', label: 'Starting (grey)', color: 'grey', states: ['starting'] },
    { key: 'stopping', label: 'Stopping (orange)', color: 'orange', states: ['stopping'] },
    { key: 'failedToStart', label: 'Failed to start (red)', color: 'red', states: ['failedToStart'] },
  ];
  const LANE_STATES = {
    starting: { label: 'Starting', color: 'grey' },
    waiting: { label: 'Waiting for a task', color: 'blue' },
    stopping: { label: 'Stopping', color: 'orange' },
    failedToStart: { label: 'Failed to start', color: 'red' },
  };

  const STOP_REASON_COLORS = ['purple', 'magenta', 'teal', 'yellow', 'green', 'ink'];
  const ERROR_COLORS = {
    'operation-error': 'red',
    'worker-error': 'orange',
    'arm-deployment-error': 'magenta',
    'creation-error': 'purple',
  };

  const STOP_REASON_PATTERNS = [
    [/^workerManager\.removeWorker/, 'removeWorker API call'],
    [/^instance not found/, 'instance not found'],
    [/^instance TERMINATED/, 'instance terminated'],
    [/^vm not found in state/, 'vm not found'],
    [/^terminateAfter/, 'terminateAfter exceeded'],
    [/^(deployment Failed|ARM Deployment failure)/, 'ARM deployment failed'],
    [/^worker never claimed/, 'never claimed work'],
    [/^worker inactive/, 'inactive'],
    [/^failed power state/, 'failed power state'],
  ];

  function accumulateDeltas(deltas) {
    const values = [];
    for (const delta of deltas) {
      values.push(values.length === 0 ? delta : values[values.length - 1] + delta);
    }
    return values;
  }

  function tableValue(table, index) {
    return index === null ? null : table[index];
  }

  function offsetTime(base, offset) {
    return offset === null ? null : base + offset;
  }

  function decodeWorkerRows(tables, columns) {
    return accumulateDeltas(columns.firstMs).map((firstMs, i) => ({
      pool: tableValue(tables.pools, columns.poolIds[i]),
      zone: tableValue(tables.zones, columns.zoneIds[i]),
      launchConfigId: tableValue(tables.launchConfigs, columns.launchConfigIds[i]),
      workerId: tableValue(tables.workerIds, columns.workerIdIds[i]),
      capacity: columns.capacities[i],
      requestedMs: offsetTime(firstMs, columns.requestedMs[i]),
      runningMs: offsetTime(firstMs, columns.runningMs[i]),
      stoppedMs: offsetTime(firstMs, columns.stoppedMs[i]),
      removedMs: offsetTime(firstMs, columns.removedMs[i]),
      stoppedReason: tableValue(tables.reasons, columns.stoppedReasonIds[i]),
      removedReason: tableValue(tables.reasons, columns.removedReasonIds[i]),
    }));
  }

  function decodeErrorRows(tables, columns) {
    return accumulateDeltas(columns.timeMs).map((timeMs, i) => ({
      timeMs,
      pool: tableValue(tables.pools, columns.poolIds[i]),
      zone: tableValue(tables.zones, columns.zoneIds[i]),
      workerId: tableValue(tables.workerIds, columns.workerIdIds[i]),
      launchConfigId: tableValue(tables.launchConfigs, columns.launchConfigIds[i]),
      kind: tableValue(tables.errorKinds, columns.kindIds[i]),
      code: tableValue(tables.errorCodes, columns.codeIds[i]),
      title: tableValue(tables.errorTitles, columns.titleIds[i]),
    }));
  }

  function decodeWorkerLifecycle(data) {
    return {
      date: data.metadata.date,
      workers: decodeWorkerRows(data.tables, data.workers),
      errors: decodeErrorRows(data.tables, data.errors),
    };
  }

  function lifecycleForPool(lifecycle, pool) {
    return {
      workers: lifecycle.workers.filter(worker => worker.pool === pool),
      errors: lifecycle.errors.filter(error => error.pool === pool),
    };
  }

  function stopReason(worker) {
    return worker.stoppedReason ?? worker.removedReason;
  }

  function retirementTime(worker) {
    const times = [worker.stoppedMs, worker.removedMs].filter(time => time !== null);
    return times.length ? Math.min(...times) : null;
  }

  function stopReasonCategory(reason) {
    if (reason === null || reason === undefined) {
      return NO_REASON;
    }
    const match = STOP_REASON_PATTERNS.find(([pattern]) => pattern.test(reason));
    return match ? match[1] : UNCLASSIFIED;
  }

  function retirementOf(worker, window) {
    const atMs = retirementTime(worker);
    if (atMs === null || atMs < window.startMs || atMs >= window.endMs) {
      return null;
    }
    return { atMs, category: stopReasonCategory(stopReason(worker)) };
  }

  function clipPhase(phase, window) {
    return {
      band: phase.band,
      startMs: Math.max(phase.startMs, window.startMs),
      endMs: Math.min(phase.endMs, window.endMs),
    };
  }

  function phase(band, startMs, endMs) {
    return { band, startMs, endMs };
  }

  function workerPhases(worker, window) {
    const retiredAt = retirementTime(worker);
    const end = retiredAt ?? window.endMs;
    const phases = [];
    if (worker.requestedMs === null) {
      if (worker.runningMs !== null) {
        phases.push(phase('running', window.startMs, end));
      }
    } else if (worker.runningMs !== null) {
      phases.push(phase('starting', worker.requestedMs, worker.runningMs));
      phases.push(phase('running', worker.runningMs, end));
    } else if (retiredAt === null) {
      phases.push(phase('starting', worker.requestedMs, window.endMs));
    } else {
      phases.push(phase('failedToStart', worker.requestedMs, retiredAt));
    }
    if (worker.stoppedMs !== null && worker.removedMs !== null && worker.stoppedMs <= worker.removedMs) {
      phases.push(phase('stopping', worker.stoppedMs, worker.removedMs));
    }
    return phases.map(p => clipPhase(p, window)).filter(p => p.endMs > p.startMs);
  }

  function topStopReasons(workers, window) {
    const counts = new Map();
    for (const worker of workers) {
      const retirement = retirementOf(worker, window);
      if (retirement) {
        counts.set(retirement.category, (counts.get(retirement.category) ?? 0) + 1);
      }
    }
    return [...counts]
      .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
      .slice(0, TOP_STOP_REASONS)
      .map(([name]) => name);
  }

  // --- locations ------------------------------------------------------------

  function locationPath(zone) {
    if (zone === null || zone === undefined) {
      return [NO_LOCATION];
    }
    if (/-[a-z]$/.test(zone)) {
      return ['Google Cloud', zone.replace(/-[a-z]$/, ''), zone];
    }
    return ['Azure', zone];
  }

  function makeNode(parent, path) {
    return {
      parent,
      path,
      depth: path.length,
      name: path.length === 0 ? 'All workers' : path[path.length - 1],
      children: [],
      workers: [],
      errors: [],
    };
  }

  function datacenterRank(name) {
    const index = DATACENTER_ORDER.indexOf(name);
    return index === -1 ? DATACENTER_ORDER.length : index;
  }

  // The tree of locations, with every worker and error attached to each node on
  // its path, so a node's numbers are the sum of its children's by construction.
  function locationTree(workers, errors) {
    const root = makeNode(null, []);
    const byKey = new Map([['', root]]);
    function nodeFor(path) {
      const key = path.join('/');
      if (!byKey.has(key)) {
        const parent = nodeFor(path.slice(0, -1));
        const node = makeNode(parent, path);
        parent.children.push(node);
        byKey.set(key, node);
      }
      return byKey.get(key);
    }
    function attach(items, field, pathOf) {
      for (const item of items) {
        const path = pathOf(item);
        for (let length = 0; length <= path.length; length++) {
          nodeFor(path.slice(0, length))[field].push(item);
        }
      }
    }
    attach(workers, 'workers', worker => locationPath(worker.zone));
    attach(errors, 'errors', error => locationPath(error.zone));
    const sortChildren = node => {
      node.children.sort((a, b) => datacenterRank(a.name) - datacenterRank(b.name) || a.name.localeCompare(b.name));
      node.children.forEach(sortChildren);
    };
    sortChildren(root);
    const nodes = [];
    (function collect(node) {
      node.index = nodes.length;
      node.id = `n${node.index}`;
      nodes.push(node);
      node.children.forEach(collect);
    })(root);
    for (const node of nodes) {
      node.leaves = nodes.filter(candidate => candidate.children.length === 0 && candidate.path.slice(0, node.depth).join('/') === node.path.join('/'));
    }
    return { root, nodes };
  }

  function isLeaf(node) {
    return node.children.length === 0;
  }

  function pathLabel(node) {
    return node.path.length === 0 ? node.name : node.path.join(' › ');
  }

  function displayName(node) {
    return `${'· '.repeat(node.depth)}${node.name}`;
  }

  // --- worker states over time ---------------------------------------------

  function bucketPlan(window) {
    const span = window.endMs - window.startMs;
    const bucketMs = Math.max(MIN_BUCKET_MS, Math.ceil(span / MAX_BUCKETS / 1000) * 1000);
    return { bucketMs, count: Math.ceil(span / bucketMs) };
  }

  function mergedBusyIntervals(runs) {
    const sorted = runs.slice().sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const run of sorted) {
      const last = merged[merged.length - 1];
      if (last && run.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, run.endMs);
      } else {
        merged.push({ startMs: run.startMs, endMs: run.endMs });
      }
    }
    return merged;
  }

  function splitRunning(running, busy) {
    const segments = [];
    let cursor = running.startMs;
    for (const interval of busy) {
      if (interval.endMs <= cursor || interval.startMs >= running.endMs) {
        continue;
      }
      const start = Math.max(interval.startMs, running.startMs);
      const end = Math.min(interval.endMs, running.endMs);
      if (start > cursor) {
        segments.push({ state: 'waiting', startMs: cursor, endMs: start });
      }
      segments.push({ state: 'runningTask', startMs: start, endMs: end });
      cursor = end;
    }
    if (cursor < running.endMs) {
      segments.push({ state: 'waiting', startMs: cursor, endMs: running.endMs });
    }
    return segments;
  }

  function stateIntervals(worker, window, busy) {
    return workerPhases(worker, window).flatMap(p =>
      p.band === 'running' ? splitRunning(p, busy) : [{ state: p.band, startMs: p.startMs, endMs: p.endMs }]
    );
  }

  function addToSeries(series, interval, window, plan) {
    const first = Math.max(0, Math.ceil((interval.startMs - window.startMs) / plan.bucketMs));
    const last = Math.min(plan.count - 1, Math.ceil((interval.endMs - window.startMs) / plan.bucketMs) - 1);
    if (last < first) {
      return;
    }
    series[interval.state][first]++;
    series[interval.state][last + 1]--;
  }

  function newSeries(plan) {
    return Object.fromEntries(STATES.map(state => [state.key, new Int32Array(plan.count + 1)]));
  }

  function countsOf(series, plan) {
    return Object.fromEntries(
      STATES.map(state => {
        const counts = new Int32Array(plan.count);
        let running = 0;
        for (let bucket = 0; bucket < plan.count; bucket++) {
          running += series[state.key][bucket];
          counts[bucket] = running;
        }
        return [state.key, counts];
      })
    );
  }

  function leafCounts(leaf, window, plan, busyByWorker) {
    const series = newSeries(plan);
    for (const worker of leaf.workers) {
      const busy = busyByWorker.get(worker.workerId) ?? [];
      for (const interval of stateIntervals(worker, window, busy)) {
        addToSeries(series, interval, window, plan);
      }
    }
    return countsOf(series, plan);
  }

  function sumCounts(countsList, plan) {
    const total = Object.fromEntries(STATES.map(state => [state.key, new Int32Array(plan.count)]));
    for (const counts of countsList) {
      for (const state of STATES) {
        for (let bucket = 0; bucket < plan.count; bucket++) {
          total[state.key][bucket] += counts[state.key][bucket];
        }
      }
    }
    return total;
  }

  function liveAt(counts, bucket) {
    return STATES.reduce((sum, state) => sum + counts[state.key][bucket], 0);
  }

  // --- markers --------------------------------------------------------------

  function emptyMarkers() {
    return { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 };
  }

  function pushMarker(markers, name, startTime, endTime, phaseCode, category, data) {
    markers.data.push(data);
    markers.name.push(name);
    markers.startTime.push(startTime);
    markers.endTime.push(endTime);
    markers.phase.push(phaseCode);
    markers.category.push(category);
    markers.length++;
  }

  function withoutEmpty(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
  }

  function indexed(getStringIndex, value) {
    return value === null || value === undefined ? undefined : getStringIndex(value);
  }

  function bandKey(index) {
    return `band${index}`;
  }

  function bandPayload(type, counts) {
    const payload = { type };
    let total = 0;
    counts.forEach((count, index) => {
      total += count;
      payload[bandKey(index)] = count;
      payload[`${bandKey(index)}AndUp`] = total;
    });
    return payload;
  }

  function bandSchema(name, bands) {
    return {
      name,
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        ...bands.map((band, index) => ({ key: bandKey(index), label: band.label, format: 'integer' })),
        ...bands.map((band, index) => ({ key: `${bandKey(index)}AndUp`, format: 'integer', hidden: true })),
      ],
      graphs: bands.map((band, index) => ({ key: `${bandKey(index)}AndUp`, color: band.color, type: 'bar' })).reverse(),
    };
  }

  // One stacked chart. bucketCounts[b] holds the count per band in bucket b. The
  // track name carries the peak, because each track is scaled to its own maximum.
  function addChart(markers, spec, window, getStringIndex) {
    const peak = spec.bucketCounts.reduce((max, counts) => Math.max(max, counts.reduce((sum, count) => sum + count, 0)), 0);
    const name = getStringIndex(`${spec.label} · max ${peak}`);
    spec.bucketCounts.forEach((counts, bucket) => {
      const startMs = bucket * spec.bucketMs;
      const endMs = Math.min((bucket + 1) * spec.bucketMs, window.endMs - window.startMs);
      pushMarker(markers, name, startMs, endMs, INTERVAL, 0, bandPayload(spec.schemaName, counts));
    });
    return bandSchema(spec.schemaName, spec.bands);
  }

  function workerBucketCounts(counts, plan) {
    return Array.from({ length: plan.count }, (_, bucket) =>
      BANDS.map(band => band.states.reduce((sum, key) => sum + counts[key][bucket], 0))
    );
  }

  function errorMinuteCounts(errors, keyOf, keys, window) {
    const minutes = Math.ceil((window.endMs - window.startMs) / MINUTE_MS);
    const counts = Array.from({ length: minutes }, () => new Array(keys.length).fill(0));
    for (const error of errors) {
      if (error.timeMs < window.startMs || error.timeMs >= window.endMs) {
        continue;
      }
      const minute = Math.floor((error.timeMs - window.startMs) / MINUTE_MS);
      counts[minute][keys.indexOf(keyOf(error))]++;
    }
    return counts;
  }

  function addErrorCharts(markers, node, window, plan, getStringIndex) {
    const errors = node.errors.filter(error => error.timeMs >= window.startMs && error.timeMs < window.endMs);
    return [addChart(markers, {
      schemaName: `WorkerErrors_${node.id}`,
      label: 'Errors/min',
      bucketMs: MINUTE_MS,
      bands: [{ label: 'Errors (red)', color: 'red' }],
      bucketCounts: errorMinuteCounts(errors, () => 'errors', ['errors'], window),
    }, window, getStringIndex)];
  }

  // Errors in the same minute, location, kind and code collapse into one marker
  // that says how many there were, so a burst of 92 does not read as one diamond.
  function addErrorMarkers(markers, node, window, categoryBase, getStringIndex) {
    const groups = new Map();
    for (const error of node.errors) {
      if (error.timeMs < window.startMs || error.timeMs >= window.endMs) {
        continue;
      }
      const minute = Math.floor((error.timeMs - window.startMs) / MINUTE_MS);
      const key = [minute, error.zone ?? NO_LOCATION, error.kind, error.code].join('\u0000');
      if (!groups.has(key)) {
        groups.set(key, { minute, first: error, count: 0 });
      }
      groups.get(key).count++;
    }
    const category = categoryBase + STATES.length + 1;
    for (const { minute, first, count } of [...groups.values()].sort((a, b) => a.minute - b.minute)) {
      const zone = first.zone ?? NO_LOCATION;
      pushMarker(markers, getStringIndex(`errors ${zone}`), minute * MINUTE_MS, (minute + 1) * MINUTE_MS, INTERVAL, category, withoutEmpty({
        type: 'PoolErrors',
        count,
        kind: indexed(getStringIndex, first.kind),
        code: getStringIndex(first.code ?? NO_CODE),
        title: indexed(getStringIndex, first.title),
        wid: indexed(getStringIndex, first.workerId),
        zone: getStringIndex(zone),
        lc: indexed(getStringIndex, first.launchConfigId),
        color: ERROR_COLORS[first.kind] ?? 'grey',
      }));
    }
  }

  // One lane per worker, named by the order the workers first appear so the
  // profiler, which sorts lanes by name, lists them in that order. The lane
  // reads left to right: starting, then the tasks it ran with the gaps between
  // them waiting for a task, then stopping. A task run sits where the worker
  // was running, so the two never overlap and the lane stays one line.
  function addLaneMarkers(markers, node, window, busyByWorker, busyRuns, categoryBase, getStringIndex) {
    const category = categoryBase + STATES.length;
    const lanes = node.workers
      .map(worker => ({ worker, phases: workerPhases(worker, window) }))
      .filter(lane => lane.phases.length > 0)
      .sort((a, b) => a.phases[0].startMs - b.phases[0].startMs || (a.worker.workerId ?? '').localeCompare(b.worker.workerId ?? ''));
    const digits = String(lanes.length).length;
    lanes.forEach(({ worker, phases }, index) => {
      const name = getStringIndex(`${String(index + 1).padStart(digits, '0')} · ${worker.workerId ?? UNKNOWN_WORKER}`);
      const reason = stopReason(worker);
      const busy = busyByWorker.get(worker.workerId) ?? [];
      for (const segment of stateIntervals(worker, window, busy)) {
        if (segment.state === 'runningTask') {
          continue;
        }
        pushMarker(markers, name, segment.startMs - window.startMs, segment.endMs - window.startMs, INTERVAL, category, withoutEmpty({
          type: 'Worker',
          state: getStringIndex(LANE_STATES[segment.state].label),
          color: LANE_STATES[segment.state].color,
          wid: indexed(getStringIndex, worker.workerId),
          zone: indexed(getStringIndex, worker.zone),
          lc: indexed(getStringIndex, worker.launchConfigId),
          cap: worker.capacity,
          reason: segment.state === 'stopping' || segment.endMs === retirementTime(worker) ? indexed(getStringIndex, reason) : undefined,
        }));
      }
      for (const run of busyRuns.get(worker.workerId) ?? []) {
        for (const running of phases.filter(p => p.band === 'running')) {
          const startMs = Math.max(run.startMs, running.startMs);
          const endMs = Math.min(run.endMs, running.endMs);
          if (endMs <= startMs) {
            continue;
          }
          pushMarker(markers, name, startMs - window.startMs, endMs - window.startMs, INTERVAL, category, withoutEmpty({
            type: 'WorkerTask',
            task: indexed(getStringIndex, run.taskId),
            state: indexed(getStringIndex, run.state),
            wid: indexed(getStringIndex, worker.workerId),
            color: run.color,
          }));
        }
      }
    });
  }

  function addStopReasonChart(markers, workers, window, getStringIndex) {
    const categories = topStopReasons(workers, window);
    if (categories.length === 0) {
      return [];
    }
    const labels = [...categories, OTHER];
    const minutes = Math.ceil((window.endMs - window.startMs) / MINUTE_MS);
    const counts = Array.from({ length: minutes }, () => new Array(labels.length).fill(0));
    for (const worker of workers) {
      const retirement = retirementOf(worker, window);
      if (retirement) {
        const index = categories.indexOf(retirement.category);
        counts[Math.floor((retirement.atMs - window.startMs) / MINUTE_MS)][index === -1 ? categories.length : index]++;
      }
    }
    const bands = labels.map((label, index) => ({ label, color: label === OTHER ? 'grey' : STOP_REASON_COLORS[index] }));
    return [addChart(markers, {
      schemaName: 'StopReasons',
      label: 'Retirements/min',
      bucketMs: MINUTE_MS,
      bands,
      bucketCounts: counts,
    }, window, getStringIndex)];
  }

  // --- the call tree and the activity strip ---------------------------------

  function stackBuilder(getStringIndex) {
    const stackTable = { frame: [], prefix: [], category: [], subcategory: [], length: 0 };
    const frameTable = {
      address: [], inlineDepth: [], category: [], subcategory: [], func: [], nativeSymbol: [],
      innerWindowID: [], implementation: [], line: [], column: [], length: 0,
    };
    const funcTable = {
      isJS: [], relevantForJS: [], name: [], resource: [], fileName: [], lineNumber: [], columnNumber: [], length: 0,
    };
    const frameByKey = new Map();
    const stackByKey = new Map();
    function frameOf(name, category) {
      const key = `${category} ${name}`;
      if (!frameByKey.has(key)) {
        funcTable.isJS.push(false);
        funcTable.relevantForJS.push(false);
        funcTable.name.push(getStringIndex(name));
        funcTable.resource.push(-1);
        funcTable.fileName.push(null);
        funcTable.lineNumber.push(null);
        funcTable.columnNumber.push(null);
        funcTable.length++;
        frameTable.address.push(-1);
        frameTable.inlineDepth.push(0);
        frameTable.category.push(category);
        frameTable.subcategory.push(0);
        frameTable.func.push(funcTable.length - 1);
        frameTable.nativeSymbol.push(null);
        frameTable.innerWindowID.push(0);
        frameTable.implementation.push(null);
        frameTable.line.push(null);
        frameTable.column.push(null);
        frameTable.length++;
        frameByKey.set(key, frameTable.length - 1);
      }
      return frameByKey.get(key);
    }
    function stackOf(prefix, name, category) {
      const frame = frameOf(name, category);
      const key = `${prefix} ${frame}`;
      if (!stackByKey.has(key)) {
        stackTable.frame.push(frame);
        stackTable.prefix.push(prefix);
        stackTable.category.push(category);
        stackTable.subcategory.push(0);
        stackTable.length++;
        stackByKey.set(key, stackTable.length - 1);
      }
      return stackByKey.get(key);
    }
    return { stackTable, frameTable, funcTable, stackOf };
  }

  // One sample per bucket, location and state, weighted by the worker time it
  // stands for, so the call tree totals are real worker-milliseconds. The
  // activity graph fills each sample's span, so the spans split the bucket in
  // proportion to the counts and threadCPUDelta carries the bucket's live
  // workers over the pool's peak: a zone reads as small beside the whole pool.
  function stateSamples(node, leafCountsByNode, plan, peak, options, getStringIndex) {
    const { stackTable, frameTable, funcTable, stackOf } = stackBuilder(getStringIndex);
    const samples = { weightType: 'tracing-ms', weight: [], stack: [], time: [], threadCPUDelta: [], length: 0 };
    const structural = options.structuralCategory;
    const idleStack = stackOf(null, '(idle)', options.idleCategory);
    let previousTime = -1;
    const nextTime = time => {
      previousTime = Math.max(time, previousTime + 0.001);
      return Math.round(previousTime * 1000) / 1000;
    };
    const leafStacks = new Map();
    function stackFor(leaf, state) {
      const key = `${leaf.path.join('/')}|${state.key}`;
      if (!leafStacks.has(key)) {
        let stack = null;
        for (const name of leaf.path.slice(node.depth)) {
          stack = stackOf(stack, name, structural);
        }
        leafStacks.set(key, stackOf(stack, state.label, options.categoryBase + STATES.indexOf(state)));
      }
      return leafStacks.get(key);
    }
    for (let bucket = 0; bucket < plan.count; bucket++) {
      const entries = [];
      for (const leaf of node.leaves) {
        for (const state of STATES) {
          const count = leafCountsByNode.get(leaf)[state.key][bucket];
          if (count > 0) {
            entries.push({ leaf, state, count });
          }
        }
      }
      const live = entries.reduce((sum, entry) => sum + entry.count, 0);
      const bucketStart = bucket * plan.bucketMs;
      if (live === 0) {
        samples.stack.push(idleStack);
        samples.time.push(nextTime(bucketStart + plan.bucketMs));
        samples.weight.push(0);
        samples.threadCPUDelta.push(0);
        samples.length++;
        continue;
      }
      let cumulative = 0;
      for (const entry of entries) {
        cumulative += entry.count;
        samples.stack.push(stackFor(entry.leaf, entry.state));
        samples.time.push(nextTime(bucketStart + (cumulative / live) * plan.bucketMs));
        samples.weight.push(entry.count * plan.bucketMs);
        samples.threadCPUDelta.push(Math.round((1000 * entry.count * plan.bucketMs) / peak));
        samples.length++;
      }
    }
    return { samples, stackTable, frameTable, funcTable };
  }

  // --- threads --------------------------------------------------------------

  function laneSchema() {
    return {
      name: 'Worker',
      tooltipLabel: '{marker.data.state} — {marker.data.wid}',
      tableLabel: '{marker.data.state} — {marker.data.wid} — {marker.data.zone}',
      chartLabel: '{marker.data.state}',
      display: ['marker-chart', 'marker-table'],
      colorField: 'color',
      fields: [
        { key: 'state', label: 'State', format: 'unique-string' },
        { key: 'wid', label: 'Worker ID', format: 'unique-string' },
        { key: 'zone', label: 'Zone', format: 'unique-string' },
        { key: 'lc', label: 'Launch config', format: 'unique-string' },
        { key: 'cap', label: 'Capacity', format: 'integer' },
        { key: 'reason', label: 'Stop reason', format: 'unique-string' },
        { key: 'color', format: 'string', hidden: true },
      ],
    };
  }

  function workerTaskSchema() {
    return {
      name: 'WorkerTask',
      tooltipLabel: 'Task {marker.data.task}: {marker.data.state}',
      tableLabel: '{marker.data.state} — {marker.data.task} — {marker.data.wid}',
      chartLabel: '{marker.data.state}',
      display: ['marker-chart', 'marker-table'],
      colorField: 'color',
      fields: [
        { key: 'task', label: 'Task ID', format: 'unique-string' },
        { key: 'state', label: 'State', format: 'unique-string' },
        { key: 'wid', label: 'Worker ID', format: 'unique-string' },
        { key: 'color', format: 'string', hidden: true },
      ],
    };
  }

  function poolErrorsSchema() {
    return {
      name: 'PoolErrors',
      tooltipLabel: '{marker.data.count}× {marker.data.title}',
      tableLabel: '{marker.data.count}× {marker.data.kind} — {marker.data.code}',
      chartLabel: '{marker.data.count}× {marker.data.code}',
      display: ['marker-chart', 'marker-table'],
      colorField: 'color',
      fields: [
        { key: 'count', label: 'Errors in this minute', format: 'integer' },
        { key: 'kind', label: 'Kind', format: 'unique-string' },
        { key: 'code', label: 'Error code', format: 'unique-string' },
        { key: 'title', label: 'Title', format: 'unique-string' },
        { key: 'wid', label: 'Worker ID (first)', format: 'unique-string' },
        { key: 'zone', label: 'Zone', format: 'unique-string' },
        { key: 'lc', label: 'Launch config (first)', format: 'unique-string' },
        { key: 'color', format: 'string', hidden: true },
      ],
    };
  }

  function busyRunsByWorker(tasks) {
    const byWorker = new Map();
    for (const task of tasks) {
      if (task.workerId === null || task.workerId === undefined) {
        continue;
      }
      if (!byWorker.has(task.workerId)) {
        byWorker.set(task.workerId, []);
      }
      byWorker.get(task.workerId).push(task);
    }
    return byWorker;
  }

  function makeThread(node, tid, parts) {
    return {
      processType: 'default',
      processName: displayName(node),
      processStartupTime: 0,
      processShutdownTime: null,
      registerTime: 0,
      unregisterTime: null,
      pausedRanges: [],
      showMarkersInTimeline: true,
      name: displayName(node),
      isMainThread: true,
      pid: pathLabel(node),
      tid,
      samples: parts.samples,
      markers: parts.markers,
      stackTable: parts.stackTable,
      frameTable: parts.frameTable,
      funcTable: parts.funcTable,
      resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
      nativeSymbols: { libIndex: [], address: [], name: [], functionSize: [], length: 0 },
    };
  }

  // options: { window, tasks, getStringIndex, categoryBase, structuralCategory,
  // idleCategory, tidBase }. tasks are { workerId, startMs, endMs, taskId, state,
  // color } for the tasks that ran in the pool.
  function locationThreads(lifecycle, pool, options) {
    const { window, getStringIndex } = options;
    const inPool = lifecycleForPool(lifecycle, pool);
    const workers = inPool.workers.filter(worker => workerPhases(worker, window).length > 0);
    const errors = inPool.errors.filter(error => error.timeMs >= window.startMs && error.timeMs < window.endMs);
    if (workers.length === 0 && errors.length === 0) {
      return { threads: [], schemas: [], categories: [], bucketMs: bucketPlan(window).bucketMs, peakWorkers: 0 };
    }
    const plan = bucketPlan(window);
    const busyRuns = busyRunsByWorker(options.tasks ?? []);
    const busyByWorker = new Map([...busyRuns].map(([id, runs]) => [id, mergedBusyIntervals(runs)]));
    const { nodes } = locationTree(workers, errors);

    const leafCountsByNode = new Map();
    for (const node of nodes.filter(isLeaf)) {
      leafCountsByNode.set(node, leafCounts(node, window, plan, busyByWorker));
    }
    const countsByNode = new Map(nodes.map(node => [node, sumCounts(node.leaves.map(leaf => leafCountsByNode.get(leaf)), plan)]));
    const rootCounts = countsByNode.get(nodes[0]);
    let peak = 1;
    for (let bucket = 0; bucket < plan.count; bucket++) {
      peak = Math.max(peak, liveAt(rootCounts, bucket));
    }

    const schemas = [laneSchema(), workerTaskSchema(), poolErrorsSchema()];
    const threads = nodes.map(node => {
      const markers = emptyMarkers();
      if (node.workers.length > 0) {
        schemas.push(addChart(markers, {
          schemaName: `WorkerStates_${node.id}`,
          label: 'Workers',
          bucketMs: plan.bucketMs,
          bands: BANDS,
          bucketCounts: workerBucketCounts(countsByNode.get(node), plan),
        }, window, getStringIndex));
      }
      schemas.push(...addErrorCharts(markers, node, window, plan, getStringIndex));
      if (node.parent === null) {
        schemas.push(...addStopReasonChart(markers, workers, window, getStringIndex));
      }
      addErrorMarkers(markers, node, window, options.categoryBase, getStringIndex);
      addLaneMarkers(markers, node, window, busyByWorker, busyRuns, options.categoryBase, getStringIndex);
      const nodeLeafCounts = new Map(node.leaves.map(leaf => [leaf, leafCountsByNode.get(leaf)]));
      const parts = stateSamples(node, nodeLeafCounts, plan, peak, options, getStringIndex);
      return makeThread(node, options.tidBase + node.index, { ...parts, markers });
    });
    return { threads, schemas, categories: PROFILE_CATEGORIES, bucketMs: plan.bucketMs, peakWorkers: peak };
  }

  function threadOrderParam(trackCount) {
    return Array.from({ length: trackCount }, (_, index) => index).join('-');
  }

  // A profile sent by postMessage never reads globalTrackOrder from the URL, and the
  // profiler then sorts the tracks by how busy they look. It does read the legacy
  // threadOrder, a list of thread indexes. Every thread here is the main thread of
  // its own process, so that list is the track order.
  function profilerQuery(trackCount) {
    return trackCount > 1 ? `?threadOrder=${threadOrderParam(trackCount)}` : '';
  }

  return {
    decodeWorkerLifecycle,
    lifecycleForPool,
    workerPhases,
    stopReasonCategory,
    topStopReasons,
    locationPath,
    locationTree,
    locationThreads,
    threadOrderParam,
    profilerQuery,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WorkerLifecycle;
}
