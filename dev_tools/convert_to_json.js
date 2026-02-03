const fs = require("fs");
const { parse } = require("csv-parse/sync");
const axios = require("axios");
const path = require("path");

// フォルダパスの設定
const inputDir = "gtfs_raw";
const outputDir = "data";

async function start() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }
  console.log("解析と形状生成を開始します...");

  const read = (file) => {
    const filePath = path.join(inputDir, file);
    if (!fs.existsSync(filePath)) return [];
    return parse(fs.readFileSync(filePath, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
    });
  };

  const calendar = read("calendar.txt");
  const calendarDates = read("calendar_dates.txt");
  const offices = read("office_jp.txt");
  const patterns = read("pattern_jp.txt");
  const routes = read("routes.txt");
  const stopTimes = read("stop_times.txt");
  const stops = read("stops.txt");
  const trips = read("trips.txt");

  if (routes.length === 0) {
    console.error("Error: gtfs_raw フォルダにデータがありません。");
    return;
  }

  // 全ての Route ID を取得
  const targetRouteIds = routes.map((r) => r.route_id);

  const stopsJson = {};
  stops.forEach((s) => {
    stopsJson[s.stop_id] = {
      name: s.stop_name,
      lat: parseFloat(s.stop_lat),
      lng: parseFloat(s.stop_lon),
      platform: s.platform_code || "",
    };
  });

  const routesJson = {};
  routes.forEach((r) => {
    routesJson[r.route_id] = {
      short_name: r.route_short_name,
      color: r.route_color || "00703c",
      office_id: r.jp_office_id,
    };
  });

  const officeMap = {};
  offices.forEach((o) => (officeMap[o.office_id] = o.office_name));

  const patternMap = {};
  patterns.forEach((p) => {
    patternMap[p.jp_pattern_id] = p.via_stop || "";
  });

  const calendarJson = {};
  calendar.forEach((c) => {
    calendarJson[c.service_id] = {
      days: [
        c.monday,
        c.tuesday,
        c.wednesday,
        c.thursday,
        c.friday,
        c.saturday,
        c.sunday,
      ],
      start: c.start_date,
      end: c.end_date,
    };
  });

  const stopTimesMap = new Map();
  stopTimes.forEach((st) => {
    if (!stopTimesMap.has(st.trip_id)) stopTimesMap.set(st.trip_id, []);
    stopTimesMap.get(st.trip_id).push(st);
  });

  const timetablesJson = {};
  const shapesToGenerate = new Map();
  const validTrips = trips.filter((t) => targetRouteIds.includes(t.route_id));

  validTrips.forEach((trip) => {
    const routeId = trip.route_id;
    if (!timetablesJson[routeId]) timetablesJson[routeId] = {};
    const myStopTimes = (stopTimesMap.get(trip.trip_id) || []).sort(
      (a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence),
    );
    if (myStopTimes.length < 2) return;

    timetablesJson[routeId][trip.trip_id] = {
      headsign: trip.trip_headsign,
      service_id: trip.service_id,
      office_id: trip.jp_office_id,
      via: patternMap[trip.jp_pattern_id] || "",
      stops: myStopTimes.map((st) => ({
        time: st.departure_time,
        stop_id: st.stop_id,
      })),
    };
    const patternKey = myStopTimes.map((s) => s.stop_id).join("|");
    if (!shapesToGenerate.has(patternKey)) {
      shapesToGenerate.set(patternKey, {
        route_id: routeId,
        headsign: trip.trip_headsign,
        stops: myStopTimes,
      });
    }
  });

  // 手動修正データの読み込み
  const manualShapesPath = path.join(__dirname, "manual_shapes.json");
  let manualShapes = {};
  if (fs.existsSync(manualShapesPath)) {
    manualShapes = JSON.parse(fs.readFileSync(manualShapesPath, "utf-8"));
  }

  // 既存の shapes.json を読み込み（再利用のため）
  const existingShapesPath = path.join(process.cwd(), "data", "shapes.json");
  let existingShapes = {};
  if (fs.existsSync(existingShapesPath)) {
    existingShapes = JSON.parse(fs.readFileSync(existingShapesPath, "utf-8"));
  }

  const shapesJson = {};
  console.log(`${shapesToGenerate.size} パターンの道路形状を確認中...`);
  let counter = 1;
  let reusedCount = 0;
  let manualCount = 0;
  let generatedCount = 0;

  for (const [patternKey, info] of shapesToGenerate) {
    if (manualShapes[patternKey]) {
      process.stdout.write(
        `\r   [${counter}/${shapesToGenerate.size}] [手動] ${info.headsign}...      `,
      );
      shapesJson[patternKey] = manualShapes[patternKey];
      manualCount++;
      counter++;
      continue;
    }

    if (existingShapes[patternKey]) {
      process.stdout.write(
        `\r   [${counter}/${shapesToGenerate.size}] [再利用] ${info.headsign}...      `,
      );
      shapesJson[patternKey] = existingShapes[patternKey];
      reusedCount++;
      counter++;
      continue;
    }

    generatedCount++;
    process.stdout.write(
      `\r   [${counter}/${shapesToGenerate.size}] [新規生成] ${info.headsign}...      `,
    );
    const stopCoords = info.stops
      .map((st) => stopsJson[st.stop_id])
      .filter((c) => c);

    if (stopCoords.length < 2) {
      counter++;
      continue;
    }

    let fullCoordinates = [];
    let stopIndices = [];
    const chunkSize = 20;

    for (let i = 0; i < stopCoords.length - 1; i += chunkSize) {
      const chunk = stopCoords.slice(i, i + chunkSize + 1);
      const coordsStr = chunk.map((c) => `${c.lng},${c.lat}`).join(";");
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
        const res = await axios.get(url);
        if (res.data.code === "Ok") {
          const segmentCoords = res.data.routes[0].geometry.coordinates;
          if (fullCoordinates.length > 0) segmentCoords.shift();
          fullCoordinates = fullCoordinates.concat(segmentCoords);
        }
      } catch (e) {
        console.error(`\nOSRM Error: ${e.message}`);
        const straight = chunk.map((c) => [c.lng, c.lat]);
        if (fullCoordinates.length > 0) straight.shift();
        fullCoordinates = fullCoordinates.concat(straight);
      }
    }

    stopIndices = [];
    stopCoords.forEach((stop, idx) => {
      let closestDist = Infinity;
      let closestIdx = 0;
      let searchStart =
        stopIndices.length > 0 ? stopIndices[stopIndices.length - 1] : 0;
      for (let i = searchStart; i < fullCoordinates.length; i++) {
        const p = fullCoordinates[i];
        const d = Math.pow(p[0] - stop.lng, 2) + Math.pow(p[1] - stop.lat, 2);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      stopIndices.push(closestIdx);
    });

    shapesJson[patternKey] = {
      coordinates: fullCoordinates,
      stop_indices: stopIndices,
    };

    // 新規生成時のみ待機
    await new Promise((r) => setTimeout(r, 1500));
    counter++;
  }

  console.log(
    `\n✅ 再利用: ${reusedCount} 件 / 新規生成: ${generatedCount} 件`,
  );

  // --- 高速パッチ & 最終データ生成 ---
  console.log("\n🚀 ルートの最適化（パッチ適用）を行っています...");
  const finalShapes = {};

  // 部分置換データの準備（A|...|B 形式）
  const segmentOverrides = {};
  Object.entries(manualShapes).forEach(([key, data]) => {
    if (key.includes("|...|")) {
      const stopIdsInTemplate = key.split("|...|");
      if (
        data.stop_indices &&
        data.stop_indices.length === stopIdsInTemplate.length
      ) {
        for (let i = 0; i < stopIdsInTemplate.length - 1; i++) {
          const startId = stopIdsInTemplate[i];
          const endId = stopIdsInTemplate[i + 1];
          const startIdx = data.stop_indices[i];
          const endIdx = data.stop_indices[i + 1];
          const segmentCoords = data.coordinates.slice(startIdx, endIdx + 1);
          segmentOverrides[`${startId}|${endId}`] = segmentCoords;
        }
      } else {
        const [startId, endId] = stopIdsInTemplate;
        segmentOverrides[`${startId}|${endId}`] = data.coordinates;
      }
    }
  });

  // 全パターンの適用
  Object.keys(shapesJson).forEach((patternKey) => {
    // 1. 完全一致の manualShapes があれば最優先
    if (manualShapes[patternKey] && !patternKey.includes("|...|")) {
      finalShapes[patternKey] = manualShapes[patternKey];
      return;
    }

    // 参照を切るためにディープコピー（重要！）
    let current = {
      coordinates: [...shapesJson[patternKey].coordinates],
      stop_indices: [...shapesJson[patternKey].stop_indices],
    };

    const stopIds = patternKey.split("|");

    // 2. 部分置換（セグメント上書き）の適用
    Object.entries(segmentOverrides).forEach(([segKey, newCoords]) => {
      const [startId, endId] = segKey.split("|");
      const startIndex = stopIds.indexOf(startId);
      const endIndex = stopIds.indexOf(endId);

      if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        const startCoordIdx = current.stop_indices[startIndex];
        const endCoordIdx = current.stop_indices[endIndex];
        const head = current.coordinates.slice(0, startCoordIdx);
        const tail = current.coordinates.slice(endCoordIdx + 1);
        current.coordinates = [...head, ...newCoords, ...tail];
        const diff = newCoords.length - (endCoordIdx - startCoordIdx + 1);
        for (let i = endIndex; i < current.stop_indices.length; i++) {
          current.stop_indices[i] += diff;
        }
      }
    });
    finalShapes[patternKey] = current;
  });

  const extraJson = { offices: officeMap, calendar_dates: calendarDates };

  const write = (name, data) =>
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(data));
  write("stops.json", stopsJson);
  write("routes.json", routesJson);
  write("timetables.json", timetablesJson);
  write("shapes.json", finalShapes); // <--- ここを finalShapes に修正！
  write("calendar.json", calendarJson);
  write("extra.json", extraJson);

  console.log("\n✅ 完了！すべての路線のデータが爆速で作成されました！");
}

start().catch(console.error);
