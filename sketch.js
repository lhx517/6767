let capture;
let handpose;
let facemesh;
let predictions = [];
let faces = [];
let modelLoaded = false;
let faceModelLoaded = false;

// --- 靈敏度與平滑化變數 ---
let smoothedHand = null;
let handMissingFrames = 0;
const SMOOTH_FACTOR = 0.45; 
const MISSING_THRESHOLD = 8; // 手消失超過 8 幀才真正判定為離開，解決閃爍問題

// 遊戲狀態機
// START_MENU, PLAYING, GAME_OVER
let gameState = 'START_MENU';
let currentStage = 1; // 1, 2, 3

// 通用計時器
let previewTimer = 0; 
let gameTimer = 3600; // 60秒 (60 * 60幀)
let stageSuccessTimer = 0;

// 第一關：種植
let seedStatus = 'IN_BAG'; // 'IN_BAG', 'HELD', 'PLANTED', 'COVERED', 'WATERING'
let seedPos = { x: 0, y: 0 };
let errorMsg = "";
let hasReleasedInitialPinch = false; // 用於判定第二次捏合
let errorTimer = 0;
let swipeCount = 0;
let lastSwipeX = 0;
let waterParticles = [];

// 第二關：害蟲
let bugs = [];
let holdingBugIndex = -1;
let bugReleasedPinch = false;

// 第三關：修剪
let badLeaves = [];
let wasScissorsOpen = false;

// 結局特效
let flowerAlpha = 0;
let flowerSize = 0;
let currentPlantScale = 0; // 當前植物的縮放比例

// 特效
let fireworks = [];
let clouds = []; // 存儲雲朵位置

// 旁白文本設定
const narrations = {
  START: "歡迎來到 AR 迷你小農場！\n今天我們要一起培育一朵美麗的花。\n請點擊木牌開始吧！",
  STAGE1_HELD: "看！種子黏在你指尖了。\n現在把它移到土堆正上方，\n再捏一下手指來播種。",
  STAGE1_PLANTED: "種子已經入土，\n快左右揮動你的手指，\n幫它蓋上厚厚的土壤吧！",
  STAGE2: "哎呀！植物長出來了，\n但上面有幾隻害蟲在搗亂。\n快把它們抓進垃圾桶！",
  STAGE3: "最後一步！植物長得真壯，\n請像拿剪刀一樣伸出食指中指，\n修剪掉枯萎的爛葉。",
  FINISH: "太棒了！在你的細心呵護下，\n花朵終於綻放了。\n這是一個完美的豐收日！"
};

function initClouds() {
  clouds = [
    { x: 150, y: 100, s: 0.5, speed: 0.2 },
    { x: width - 200, y: 150, s: 0.8, speed: 0.15 },
    { x: width / 2, y: 80, s: 0.6, speed: 0.1 }
  ];
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  capture = createCapture(VIDEO);
  // 優化效能：固定在 640x480 讓 AI 跑得動
  capture.size(640, 480);
  capture.hide();

  // 1. 調整模型偵測參數
  const options = {
    flipHorizontal: false, // 因為我們在 draw 用 scale(-1,1) 了
    detectionConfidence: 0.8, // 提高偵測門檻（預設約 0.7）
    scoreThreshold: 0.75,
  };

  handpose = ml5.handpose(capture, options, () => {
    console.log("Model Ready!");
    modelLoaded = true;
  });
  handpose.on('predict', results => {
    predictions = results;
  });

  // 初始化臉部偵測
  facemesh = ml5.facemesh(capture, { flipHorizontal: false }, () => {
    console.log("Face Model Ready!");
    faceModelLoaded = true;
  });
  facemesh.on('predict', results => {
    faces = results;
  });

  initStage1();
  initClouds();
}

function draw() {
  drawBackground(); 
  push();
  translate(width, 0);
  scale(-1, 1);
  image(capture, 0, 0, width, height);
  pop();

  // 2. 實作平滑化演算法 (Temporal Smoothing)
  // 1. 更新平滑化手部資料 (支援多手偵測下的主手平滑)
  if (predictions.length > 0) {
    let currentHand = predictions[0].landmarks;
    handMissingFrames = 0;
    if (!smoothedHand) smoothedHand = currentHand;
    else {
      for (let i = 0; i < 21; i++) {
        smoothedHand[i][0] = lerp(smoothedHand[i][0], currentHand[i][0], SMOOTH_FACTOR);
        smoothedHand[i][1] = lerp(smoothedHand[i][1], currentHand[i][1], SMOOTH_FACTOR);
      }
    }
  } else {
    handMissingFrames++;
    if (handMissingFrames > MISSING_THRESHOLD) smoothedHand = null;
  }

  // 2. 決定互動手：優先選擇正在捏合的手，若無則使用第一隻偵測到的手
  let hand = smoothedHand;
  for (let p of predictions) {
    if (isPinching(p.landmarks)) { hand = p.landmarks; break; }
  }

  // --- 動態更新植物生長數值 ---
  let targetScale = 0;
  if (gameState === 'PLAYING') {
    if (currentStage === 1) {
      // 第一關在開始澆水後或是蓋土完成後長出幼苗
      if (seedStatus === 'WATERING' || seedStatus === 'COVERED') targetScale = 0.4;
    } 
    else if (currentStage === 2) targetScale = 0.8;
    else if (currentStage === 3) targetScale = 1.2;
  } else if (gameState === 'GAME_OVER') {
    targetScale = 1.5;
  }

  // 使用 lerp 讓縮放比例平滑趨近目標值
  currentPlantScale = lerp(currentPlantScale, targetScale, 0.03);

  // 如果植物已經開始生長，就把它畫出來 (畫在手部回饋之前，才不會擋住手指點)
  if (currentPlantScale > 0.01) {
    drawPlant(width / 2, height - 150, currentPlantScale);
  }

  if (gameState === 'START_MENU') {
    drawStartMenu();
  } else if (gameState === 'PLAYING') {
    drawProgressUI();
    if (currentStage === 1) runStage1(hand);
    else if (currentStage === 2) runStage2(hand);
    else if (currentStage === 3) runStage3(hand);
    
    drawTimerUI();
    // 倒數計時進度條
    noStroke();
    fill(255, 50);
    rect(0, 0, map(gameTimer, 0, 3600, 0, width), 5);

    gameTimer--;
    if (gameTimer <= 0) resetCurrentStage();
  } else if (gameState === 'GAME_OVER') {
    runGameOver();
  }
  
  // 更新與繪製煙火特效
  updateFireworks();

  // 繪製右側旁白
  drawNarrator();

  // 全程偵測臉部並帶上農夫帽
  if (faces.length > 0) drawFarmerHat();

  // 繪製所有偵測到的手部回饋
  for (let p of predictions) {
    drawHandFeedback(p.landmarks);
  }

  // 模型載入提示
  if (!modelLoaded || !faceModelLoaded) {
    fill(255);
    textAlign(CENTER);
    textSize(20);
    text("正在啟動攝影機並載入 AI 模型...", width / 2, height - 50);
  }

}

// --- 核心判定演算法 ---
function checkThumbsUp(hand) {
  if (!hand) return false;
  // 大拇指尖(4) Y 座標小於大拇指根(2)，其餘指尖 Y 座標大於其各自指根 (握拳)
  let thumbUp = hand[4][1] < hand[2][1];
  let othersCurled = (hand[8][1] > hand[5][1] && hand[12][1] > hand[9][1] && 
                      hand[16][1] > hand[13][1] && hand[20][1] > hand[17][1]);
  return thumbUp && othersCurled;
}

function isPinching(hand) {
  if (!hand) return false;
  let p1 = getHandPos(hand, 4); // 大拇指
  // 檢查大拇指 (4) 與其餘四根手指尖 (8, 12, 16, 20) 的距離
  let tips = [8, 12, 16, 20];
  for (let t of tips) {
    let p2 = getHandPos(hand, t);
    if (dist(p1.x, p1.y, p2.x, p2.y) < 70) return true; // 稍微縮小判定，讓動作更精確
  }
  return false;
}

// --- 關卡邏輯 ---
function drawStartMenu() {
  push();
  // 看板陰影
  noStroke();
  fill(0, 50);
  rect(width/2 - 245, height/2 - 115, 500, 240, 15);

  // 木質看板與紋路
  fill(139, 94, 60);
  stroke(80, 50, 20);
  strokeWeight(8);
  rect(width/2 - 250, height/2 - 120, 500, 240, 15);
  
  // 裝飾木紋線條
  strokeWeight(2);
  stroke(160, 110, 70, 150);
  for(let i = -100; i < 100; i += 30) {
    line(width/2 - 230, height/2 + i, width/2 + 230, height/2 + i);
  }
  
  // 看板支柱
  stroke(80, 50, 20);
  strokeWeight(6);
  fill(100, 70, 30);
  rect(width/2 - 200, height/2 + 120, 20, 100);
  rect(width/2 + 180, height/2 + 120, 20, 100);
  
  fill(255, 240, 200);
  noStroke();
  textAlign(CENTER);
  drawingContext.shadowBlur = 10;
  drawingContext.shadowColor = 'rgba(0,0,0,0.3)';
  textSize(48);
  textStyle(BOLD);
  text("AR 迷你小農場", width/2, height/2 - 20);
  textSize(22);
  fill(255, 255, 255, 200);
  text("── 點擊畫面開始種植之旅 ──", width/2, height/2 + 50);
  pop();

  if (mouseIsPressed) {
    gameState = 'PLAYING';
    currentStage = 1;
    gameTimer = 3600;
  }
}

function drawProgressUI() {
  push();
  let stages = ["🌱 播種", "🐛 除蟲", "✂️ 修剪"];
  textAlign(CENTER);
  textSize(22);
  for(let i=0; i<3; i++) {
    let x = map(i, 0, 2, width/2 - 200, width/2 + 200);
    if (currentStage === i+1) {
      fill(255, 255, 0);
      drawingContext.shadowBlur = 15;
      drawingContext.shadowColor = 'yellow';
    } else fill(255, 255, 255, 120);
    text(stages[i], x, 40);
    drawingContext.shadowBlur = 0;
  }
  pop();
}

function initStage1() { seedStatus = 'IN_BAG'; swipeCount = 0; waterParticles = []; hasReleasedInitialPinch = false; }

function runStage1(hand) {
  // 將種子袋往中間移動 (原本 100 -> 現在 250)
  let bagX = 250, bagY = height / 2, bagW = 100, bagH = 150;
  let dirtX = width / 2, dirtY = height - 120, dirtR = 140; 
  
  // 畫袋子
  drawStyledBag(bagX, bagY, bagW, bagH);
  
  // 畫土壤
  noStroke();
  fill(70, 45, 25, seedStatus === 'COVERED' || seedStatus === 'WATERING' ? 255 : 180);
  arc(dirtX, dirtY, dirtR * 2, dirtR, PI, TWO_PI);
  // 土壤表面細節
  fill(90, 65, 45);
  ellipse(dirtX, dirtY - 5, dirtR * 1.6, dirtR * 0.35);

  if (seedStatus === 'IN_BAG') {
    drawSeed(bagX + bagW / 2, bagY + bagH / 2 + 20);
  }

  if (hand) {
    let interactPt = getHandPos(hand, 4); // 改用大拇指作為互動基準點
    let ix = interactPt.x;
    let iy = interactPt.y;

    if (seedStatus === 'IN_BAG') {
      if (isPinching(hand) && ix > bagX - 30 && ix < bagX + bagW + 30 && iy > bagY - 30 && iy < bagY + bagH + 30) {
        seedStatus = 'HELD';
        hasReleasedInitialPinch = false; // 剛捏起來，標記還沒放開過
      }
    } else if (seedStatus === 'HELD') {
      if (!isPinching(hand)) {
        hasReleasedInitialPinch = true; // 捏起後只要放開過一次，下一次捏合就是「放下」
      }
      // 如果放開過後再次捏合，且在土壤範圍
      if (hasReleasedInitialPinch && isPinching(hand) && dist(ix, iy, dirtX, dirtY - 20) < dirtR + 60) {
        seedStatus = 'PLANTED';
        seedPos = { x: dirtX + random(-20, 20), y: dirtY - 15 };
      }
    }
    if (seedStatus === 'PLANTED') {
      if ((lastSwipeX < dirtX && ix > dirtX) || (lastSwipeX > dirtX && ix < dirtX)) swipeCount++;
      lastSwipeX = ix;
      if (swipeCount >= 10) seedStatus = 'COVERED';
      fill(255); textSize(24); text("請左右撥動手指蓋土 ✨", width/2, height/2);
    }
    if (seedStatus === 'HELD') { drawSeed(ix, iy); }
  }
  if (seedStatus === 'PLANTED') { drawSeed(seedPos.x, seedPos.y); }
  if (seedStatus === 'COVERED') { seedStatus = 'WATERING'; stageSuccessTimer = 180; }
  if (seedStatus === 'WATERING') {
    if (frameCount % 5 === 0) waterParticles.push({x: dirtX + random(-40, 40), y: dirtY - 150, v: random(3, 6)});
    fill(0, 150, 255); noStroke();
    for (let i = waterParticles.length-1; i >=0; i--) {
      ellipse(waterParticles[i].x, waterParticles[i].y, 8, 12);
      waterParticles[i].y += waterParticles[i].v;
      if (waterParticles[i].y > height) waterParticles.splice(i, 1);
    }
    if (--stageSuccessTimer <= 0) {
      initStage2();
      currentStage = 2;
    }
  }
  drawError();
}

function initStage2() {
  bugs = [];
  // 讓害蟲生長在植物上面，隨基座高度調整
  for (let i = 0; i < 4; i++) bugs.push({ x: width/2 + random(-60, 60), y: height - 250 + random(-60, 60), ox: 0, oy: 0 });
  bugs.forEach(b => { b.ox = b.x; b.oy = b.y; });
  holdingBugIndex = -1;
  bugReleasedPinch = false;
}

function runStage2(hand) {
  // 將垃圾桶往中間與下方移動 (原本 width-150 -> 現在 width-300)
  let binX = width - 350, binY = height/2 - 100, binW = 120, binH = 150;
  drawTrashBin(binX, binY, binW, binH);

  if (hand) {
    let interactPt = getHandPos(hand, 4); // 同樣改用大拇指作為互動基準點
    let ix = interactPt.x;
    let iy = interactPt.y;

    if (holdingBugIndex === -1) {
      if (isPinching(hand)) {
        // 捏一下抓起害蟲
        for (let i = 0; i < bugs.length; i++) {
          if (dist(ix, iy, bugs[i].x, bugs[i].y) < 60) { 
            holdingBugIndex = i; 
            bugReleasedPinch = false; 
            break; 
          }
        }
      }
    } else {
      // 蟲子黏在手上
      bugs[holdingBugIndex].x = ix;
      bugs[holdingBugIndex].y = iy;

      // 自動檢查：如果害蟲位置進入垃圾桶範圍，自動被丟掉
      if (ix > binX && ix < binX + binW && iy > binY && iy < binY + binH) {
        createFirework(binX + binW / 2, binY + binH / 2); // 成功丟入，放煙火！
        bugs.splice(holdingBugIndex, 1);
        holdingBugIndex = -1; // 丟掉後重置抓取狀態
      } else {
        // 如果不在垃圾桶內，保留「再捏一下放下」的機制，方便玩家手動釋放
        if (!isPinching(hand)) bugReleasedPinch = true;
        if (bugReleasedPinch && isPinching(hand)) {
          holdingBugIndex = -1;
        }
      }
    }
  }
  bugs.forEach(b => drawBug(b.x, b.y));
  if (bugs.length === 0) {
    initStage3();
    currentStage = 3;
  }
}

function initStage3() {
  badLeaves = [];
  // 讓爛葉出現在植物枝幹範圍內
  for (let i = 0; i < 6; i++) badLeaves.push({ x: width/2 + random(-120, 120), y: height - 280 + random(-80, 80), falling: false });
}

function runStage3(hand) {
  if (hand) {
    let p8 = getHandPos(hand, 8);
    let p12 = getHandPos(hand, 12);
    let ix = p8.x, iy = p8.y;
    let mx = p12.x, my = p12.y;
    let d = dist(ix, iy, mx, my);
    if (d > 60) wasScissorsOpen = true;
    if (wasScissorsOpen && d < 25) {
      for (let l of badLeaves) if (!l.falling && dist(ix, iy, l.x, l.y) < 40) l.falling = true;
      wasScissorsOpen = false;
    }
    stroke(255, 255, 0); strokeWeight(3); line(ix, iy, mx, my);
  }
  for (let i = badLeaves.length-1; i >= 0; i--) {
    let l = badLeaves[i];
    fill(100, 60, 20); noStroke(); ellipse(l.x, l.y, 40, 25);
    if (l.falling) { l.y += 10; if (l.y > height) badLeaves.splice(i, 1); }
  }
  if (badLeaves.length === 0) gameState = 'GAME_OVER';
}

function drawFarmerHat() {
  if (faces.length === 0) return;

  let face = faces[0].scaledMesh;
  // 取得關鍵點：10 為額頭中心
  let forehead = getMappedPos(face[10][0], face[10][1]);
  // 取得左右眼角 (33, 263) 來計算頭部寬度與傾斜度
  let eyeL = getMappedPos(face[33][0], face[33][1]);
  let eyeR = getMappedPos(face[263][0], face[263][1]);
  
  let headWidth = dist(eyeL.x, eyeL.y, eyeR.x, eyeR.y) * 2.8;
  // 修正角度：在鏡像座標下，交換眼角順序來修正 180 度翻轉問題
  let angle = atan2(eyeL.y - eyeR.y, eyeL.x - eyeR.x);

  push();
  // 往上移動一點，避免擋住眼睛
  translate(forehead.x, forehead.y - headWidth * 0.05);
  rotate(angle);
  
  // 1. 帽沿 (Brim) - 變得更扁平 (高度從 0.35 縮減為 0.15)
  fill(220, 190, 150, 230); // 經典草帽黃
  stroke(140, 110, 70);
  strokeWeight(3);
  ellipse(0, 0, headWidth, headWidth * 0.15);
  
  // 2. 帽頂 (Crown) - 變得更矮
  fill(200, 170, 130, 230);
  arc(0, 0, headWidth * 0.45, headWidth * 0.2, PI, TWO_PI, CHORD);
  
  // 3. 裝飾咖啡色帶 (Ribbon) - 調整位置與高度
  fill(100, 70, 30);
  noStroke();
  rect(-headWidth * 0.22, -headWidth * 0.04, headWidth * 0.44, headWidth * 0.04);

  pop();
}

function drawNarrator() {
  let txt = "";
  if (gameState === 'START_MENU') txt = narrations.START;
  else if (gameState === 'GAME_OVER') txt = narrations.FINISH;
  else if (gameState === 'PLAYING') {
    if (currentStage === 1) {
      if (seedStatus === 'HELD') txt = narrations.STAGE1_HELD;
      else if (seedStatus === 'PLANTED') txt = narrations.STAGE1_PLANTED;
      else txt = "伸手捏一下左邊袋子裡的種子吧！";
    } else if (currentStage === 2) txt = narrations.STAGE2;
    else if (currentStage === 3) txt = narrations.STAGE3;
  }
  if (!txt) return;
  push();
  let x = width - 360, y = height - 220;
  fill(255, 245, 230, 220); stroke(139, 94, 60, 150); strokeWeight(3);
  rect(x, y, 320, 160, 20);
  fill(80, 50, 20); noStroke(); textAlign(LEFT, TOP); textSize(20); textStyle(BOLD);
  text(txt, x + 25, y + 25, 270, 110);
  pop();
}

function runGameOver() {
  flowerAlpha = min(flowerAlpha + 2, 255);
  flowerSize = min(flowerSize + 0.5, 100);
  push();
  translate(width/2, height/2 - 100);
  fill(255, 100, 200, flowerAlpha);
  for (let i = 0; i < 8; i++) { rotate(PI/4); ellipse(flowerSize/2, 0, flowerSize, flowerSize/2); }
  fill(255, 255, 0, flowerAlpha); ellipse(0, 0, flowerSize/2, flowerSize/2);
  pop();
  if (flowerAlpha >= 255) { fill(255); textSize(40); text("種植成功！恭喜完成！", width/2, 100); }
}

// 泛用座標映射輔助函式
function getMappedPos(rawX, rawY) {
  let vW = capture.elt.videoWidth || 640;
  let vH = capture.elt.videoHeight || 480;
  return {
    x: map(rawX, 0, vW, width, 0),
    y: map(rawY, 0, vH, 0, height)
  };
}

// 統一座標映射輔助函式，解決偏位問題
function getHandPos(hand, i) {
  if (!hand || !hand[i]) return { x: 0, y: 0 };
  // 使用 capture 的真實解析度 (640x480) 映射到全螢幕畫布，並做鏡像處理
  return {
    x: map(hand[i][0], 0, 640, width, 0),
    y: map(hand[i][1], 0, 480, 0, height)
  };
}

// --- 視覺回饋工具 ---
function drawHandFeedback(hand) {
  if (!hand) return;
  
  let pinching = isPinching(hand);
  
  // 手指連接順序定義
  const connections = [
    [0, 1, 2, 3, 4],     // 大拇指
    [0, 5, 6, 7, 8],     // 食指
    [0, 9, 10, 11, 12],  // 中指
    [0, 13, 14, 15, 16], // 無名指
    [0, 17, 18, 19, 20], // 小指
    [5, 9, 13, 17, 5]    // 掌心
  ];

  push();
  // 1. 繪製骨架連線
  stroke(255, 255, 255, 80);
  strokeWeight(2);
  noFill();

  // 2. 繪製 21 個偵測點
  noStroke();
  for (let i = 0; i < hand.length; i++) {
    let p = getHandPos(hand, i);
    
    if (pinching && [4, 8, 12, 16, 20].includes(i)) {
      // 捏合時發光
      drawingContext.shadowBlur = 15;
      drawingContext.shadowColor = 'cyan';
      fill(255, 0, 0); 
      ellipse(p.x, p.y, 16, 16);
      drawingContext.shadowBlur = 0;
    } else if (i === 4 || i === 8 || i === 12) {
      // 關鍵指尖點（4:拇指, 8:食指, 12:中指）顯示為黃色
      fill(255, 255, 0, 200); 
      ellipse(p.x, p.y, 12, 12);
    } else {
      fill(0, 255, 0, 150); 
      ellipse(p.x, p.y, 8, 8);
    }
  }
  pop();
}

// --- 輔助工具 ---
function createFirework(x, y) {
  for (let i = 0; i < 20; i++) {
    fireworks.push({
      x: x,
      y: y,
      vx: random(-4, 4),
      vy: random(-8, -2),
      alpha: 255,
      color: [random(100, 255), random(100, 255), random(255)] // 隨機亮色
    });
  }
}

function updateFireworks() {
  for (let i = fireworks.length - 1; i >= 0; i--) {
    let f = fireworks[i];
    fill(f.color[0], f.color[1], f.color[2], f.alpha);
    noStroke();
    ellipse(f.x, f.y, 6, 6);
    f.x += f.vx;
    f.y += f.vy;
    f.vy += 0.2; // 重力效果
    f.alpha -= 5;
    if (f.alpha <= 0) fireworks.splice(i, 1);
  }
}

function drawBackground() {
  let c1 = color(135, 206, 235); // 天空藍
  let c2 = color(200, 255, 200); // 草地綠
  for (let y = 0; y < height; y++) {
    let inter = map(y, 0, height, 0, 1);
    let c = lerpColor(c1, c2, inter);
    stroke(c);
    line(0, y, width, y);
  }
  
  // 畫太陽：增加隨時間變化的亮波與光暈
  let sunPulse = sin(frameCount * 0.04);
  let sunGlow = map(sunPulse, -1, 1, 30, 70);
  let sunBrightness = map(sunPulse, -1, 1, 200, 255);

  push();
  drawingContext.shadowBlur = sunGlow;
  drawingContext.shadowColor = 'orange';
  fill(255, sunBrightness, 150, 240);
  ellipse(width - 100, 100, 80, 80);
  pop();

  // 畫農場柵欄
  push();
  fill(190, 150, 110);
  stroke(100, 70, 40);
  strokeWeight(2);
  let fenceY = height - 160;
  for(let x=0; x<width; x+=60) {
    // 柵欄陰影
    fill(0, 30); rect(x+4, fenceY, 20, 80);
    fill(190, 150, 110);
    rect(x, fenceY, 20, 80); // 豎條
  }
  rect(0, fenceY + 20, width, 10); // 橫條
  pop();

  // 畫雲朵
  clouds.forEach(c => {
    push();
    noStroke();
    fill(255, 255, 255, 230);
    ellipse(c.x, c.y, 80 * c.s, 50 * c.s);
    ellipse(c.x + 30 * c.s, c.y + 10 * c.s, 60 * c.s, 40 * c.s);
    c.x += c.speed;
    if (c.x > width + 100) c.x = -100;
    pop();
  });
}

function drawStyledBag(x, y, w, h) {
  push();
  fill(160, 120, 80);
  stroke(100, 70, 40);
  strokeWeight(3);
  rect(x, y, w, h, 10);
  // 袋子上的標籤
  fill(255, 240, 200);
  rect(x + 10, y + 40, w - 20, 40, 5);
  fill(80, 50, 20);
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(18);
  text("SEED", x + w/2, y + 60);
  pop();
}

function drawTrashBin(x, y, w, h) {
  push();
  // 桶身
  fill(80, 90, 100);
  stroke(50);
  strokeWeight(2);
  rect(x, y + 20, w, h - 20, 5);
  // 條紋細節
  for(let i=1; i<4; i++) line(x + i*w/4, y+30, x + i*w/4, y+h-10);
  // 桶蓋
  fill(100, 110, 120);
  rect(x - 5, y, w + 10, 20, 5);
  pop();
}

function drawBug(x, y) {
  push();
  // 微微蠕動的動畫
  let wobble = sin(frameCount * 0.2) * 3;
  translate(x, y + wobble);
  rotate(sin(frameCount * 0.1) * 0.1);
  
  fill(30, 20, 10); 
  ellipse(0, 0, 24, 18); // 蟲身加大
  fill(255, 0, 0, 200); // 紅色發光背部
  ellipse(0, -3, 14, 11);
  stroke(0); strokeWeight(1);
  line(-10, -5, -15, -10); line(10, -5, 15, -10); // 觸角
  pop();
}

function drawSeed(x, y) {
  push();
  translate(x, y);
  fill(100, 60, 30);
  stroke(255, 200, 150, 150);
  strokeWeight(1);
  ellipse(0, 0, 15, 22);
  noStroke();
  fill(255, 255, 255, 100); 
  ellipse(-3, -5, 5, 8);
  pop();
}

function drawPlant(x, y, sc) {
  push(); 
  // 風吹搖擺
  let wind = sin(frameCount * 0.05) * 0.05;
  translate(x, y); 
  rotate(wind);
  scale(sc);
  // 漸層莖部
  for(let i=0; i<10; i++) {
    stroke(40 + i*8, 160, 40); strokeWeight(14 - i);
    line(0, -i*20, 0, -(i+1)*20);
  }
  // 漸層葉子
  fill(60, 180, 60); noStroke();
  push(); rotate(0.4); ellipse(40, -100, 70, 35); pop();
  push(); rotate(-0.4); ellipse(-40, -150, 70, 35); pop();
  pop();
}

function drawTimerUI() {
  fill(255); textSize(20); textAlign(LEFT);
  text("剩餘時間: " + ceil(gameTimer / 60) + "s", 30, 40);
}

function drawError() {
  if (errorTimer > 0) {
    fill(255, 0, 0); textSize(24); textAlign(CENTER);
    text(errorMsg, width/2, 100);
    errorTimer--;
  }
}

function resetCurrentStage() {
  if (currentStage === 1) initStage1();
  else if (currentStage === 2) initStage2();
  else if (currentStage === 3) initStage3();
  gameTimer = 3600; // 重置計時器
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
