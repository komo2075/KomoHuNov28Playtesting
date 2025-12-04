// ====== Tunables ======
let SLEEP_AFTER_MS = 10000;
let SHY_HOLD_MS    = 1200;
let HAPPY_HOLD_MS  = 10000;

//final submission addition, v1.0.7
// 聆听冷却控制
let lastListeningEndAt = 0;          // 最近一次“结束聆听”的时间
const LISTEN_COOLDOWN_MS = 30000;    // 聆听结束后 30 秒内不再进入聆听


//final submission addition, v1.0.6
// 防止状态切换过快
let lastStateChangeAt = 0;
const MIN_STATE_INTERVAL_MS = 400;  // 两次状态切换之间至少 0.4 秒

//final submission addition, v1.0.6
// 音量平滑参数
let smoothLevel = 0;
const LEVEL_SMOOTH_ALPHA = 0.2;  // 越小越平稳


// 轻音触发倾听的判定时间
let LISTEN_TRIGGER_MS = 500;   // 持续 0.5 秒轻音就进入倾听
let LISTEN_QUIET_MS   = 800;   // 倾听中连续安静 0.8 秒就退出

// thresholds 可调或校准
let SOFT_TH = 0.02;
let LOUD_TH = 0.12;

// 原有的灵敏度等保持不动
let videos = {};
let current = "live";

let lastInputAt = 0;  // 用于 sleep 判定
let shyUntil = 0;
let happyUntil = 0;
let allLoaded = false;
let started = false;
let isMuted = false;   // 是否闭麦

let sens = 1.0;

//playtest2, v1.0.4
// ====== BGM 系统 ======
let bgm = {};               // 存放各状态的 BGM Audio 对象
let currentBgmKey = null;   // 当前正在播放的 BGM key（"happy" / "sleep" / null）
let bgmFadeMs = 800;        // 淡入淡出时间（毫秒），可以自己调
let bgmFadeRaf = null;      // requestAnimationFrame 句柄



// Web Audio
let audioCtx, analyser, mediaStream, sourceNode;
let timeBuf;

let wakeTarget = null;  // 从睡眠里醒来之后要去的目标状态：live/happy/shy
let listeningTarget = null;  // listening 出来的目标

// 倾听触发用的小计时
let listeningCandidateSince = 0; // 轻音开始时间
let listeningQuietSince    = 0;  // 倾听中安静开始时间

// UI refs
const $ = (id)=>document.getElementById(id);

//final submission addition, v1.0.6
// 定时提示用户说话的功能
// 每隔一段时间，如果处于 live 或 sleep_loop 状态，且一段时间内没有输入
let lastPromptAt = 0;
const PROMPT_INTERVAL_MS = 60000; // 每 60 秒最多问一次
const PROMPTS = [
  "Tell me something that happened today.",
  "What are you working on right now.",
  "What made you smile today."
];

//final submission addition, v1.0.7
// 每个状态至少要播放多久，单位 ms
// 这些数字只是示例，你可以根据视频时长微调
const STATE_MIN_HOLD = {
  shy:           1000,  // 害羞动画大约 1s
  happy:         11000,  // 开心状态大约 11s（你现在的 HAPPY_HOLD_MS 接近 8~10s）
  listening_in:  1200,  // 走上前聆听 in
  listening_out: 1200,  // 走回去 out
  sleep_in:      1500,  // 入睡动画
  sleep_out:     1500,  // 醒来动画
  // live / listening_loop / sleep_loop 不写＝0，可以随时切

  //final submission addition, v1.0.8 
  // ★ 新增：中段循环的“锁定时长”
  sleep_loop:     60000,  // 睡觉中间至少 60 秒完全不接新触发
  listening_loop: 10000   // 聆听中间至少 10 秒不接新触发
};

let stateHoldUntil = 0;   // 当前状态被锁定到的时间点（毫秒，基于 millis()）




function maybeShowPrompt(now){
  // 只在 live 或 sleep_loop 这种“安静状态”下问
  if(current !== "live" && current !== "sleep_loop") return;

  if(now - lastPromptAt < PROMPT_INTERVAL_MS) return;

  // 有一段时间比较安静才触发，比如 15 秒没大动静
  if(now - lastInputAt < 15000) return;

  const msg = PROMPTS[Math.floor(Math.random()*PROMPTS.length)];
  showSpeechBubble(msg);   // 你可以用一个小 div 在舞台上方显示一条文字
  lastPromptAt = now;
}


function setup(){
  noCanvas();

  // build videos
  const stage = $("stage");

  // 所有视频的名字
  const videoNames = [
    "live",
    "happy",
    "shy",
    "sleep_in",
    "sleep_loop",
    "sleep_out",
    "listening_in",
    "listening_loop",
    "listening_out"
  ];

  videoNames.forEach(name=>{
    const v = document.createElement("video");
    v.id = `vid-${name}`;
    v.src = `assets/${name}.mp4`;

    // 过渡动画只播一次, 其余循环
    if(name === "sleep_in" || name === "sleep_out" ||
       name === "listening_in" || name === "listening_out"){
      v.loop = false;
    }else{
      v.loop = true;
    }

    v.muted = false;
    v.volume = 1.0;

    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("webkit-playsinline","true");
    v.setAttribute("x5-playsinline","true");
    v.addEventListener("canplaythrough", checkLoaded, { once:true });

    // 睡眠的进出场回调
    if(name === "sleep_in"){
      v.addEventListener("ended", onSleepInEnded);
    }
    if(name === "sleep_out"){
      v.addEventListener("ended", onSleepOutEnded);
    }

    // 倾听的进出场回调
    if(name === "listening_in"){
      v.addEventListener("ended", onListeningInEnded);
    }
    if(name === "listening_out"){
      v.addEventListener("ended", onListeningOutEnded);
    }

    stage.appendChild(v);
    videos[name] = v;
  });

  //playtest2 BGM 系统, v1.0.4
  // ====== 载入 BGM ======
  const bgmConfig = {
    happy: "assets/audio/happy_loop.mp3",
    sleep: "assets/audio/sleep_loop_bgm.mp3"
  };

  for(const key in bgmConfig){
    const a = new Audio(bgmConfig[key]);
    a.loop = true;      // happy 和 sleep_loop 都是循环 BGM
    a.volume = 0;       // 先静音，等需要时淡入
    bgm[key] = a;
  }



  switchTo("live", {resetTime:false});
  $("loading").style.display = "block";

  stage.addEventListener("pointerdown", ()=>{
    resumeAudio();
    if(!started) return;
    triggerHappy();
  });

  $("startBtn").addEventListener("click", startAll);

  // 控制面板
  $("sens").addEventListener("input", e=> sens = parseFloat(e.target.value));
  $("softTH").addEventListener("input", e=> SOFT_TH = parseFloat(e.target.value));
  $("loudTH").addEventListener("input", e=> LOUD_TH = parseFloat(e.target.value));
  $("calBtn").addEventListener("click", calibrate2s);

  //新控制playtest2
    // 打开 / 关闭 Settings 和 Help 弹窗
    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsClose").addEventListener("click", closeSettings);
    $("settingsBackdrop").addEventListener("click", closeSettings);

    $("helpBtn").addEventListener("click", openHelp);
    $("helpClose").addEventListener("click", closeHelp);
    $("helpBackdrop").addEventListener("click", closeHelp);

    $("aboutBtn").addEventListener("click", openAbout);
    $("aboutClose").addEventListener("click", closeAbout);
    $("aboutBackdrop").addEventListener("click", closeAbout);
  
    // ESC 关闭所有弹窗
    window.addEventListener("keydown", (e)=>{
      if(e.key === "Escape"){
        closeSettings();
        closeHelp();
        closeAbout();
      }
    });


  // 设备选择
  $("refreshBtn").addEventListener("click", listMics);
  $("micSelect").addEventListener("change", async ()=>{
    if(started) await startMicWithDevice(($("micSelect").value));
  });
    // 闭麦按钮
    $("muteBtn").addEventListener("click", toggleMute);
    window.addEventListener("keydown", (e)=>{
      if(e.key.toLowerCase() === "m") toggleMute();   // M 键快速开关
    });

  window.addEventListener("pointerdown", resumeAudio, { passive:true });
  window.addEventListener("touchstart", resumeAudio, { passive:true });
  window.addEventListener("keydown", resumeAudio);

  // 预先列设备
  listMics();
}

async function startAll(){
  if(started) return;
  started = true;
  $("startBtn").disabled = true;

  await resumeAudio();
  await startMicWithDevice(($("micSelect").value || undefined)).catch(console.error);

  // warm up videos
  Object.values(videos).forEach(v=>{ v.play().catch(()=>{}); v.pause(); });
  switchTo("live");
  $("startBtn").style.display = "none";
}

async function listMics(){
  try{
    // 需先拿一次权限，设备标签才可见
    await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch{}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === "audioinput");
  const sel = $("micSelect");
  sel.innerHTML = "";
  mics.forEach(d=>{
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.text = d.label || `Microphone ${sel.length+1}`;
    sel.appendChild(opt);
  });
}

async function startMicWithDevice(deviceId){
  // 清理旧流
  if(mediaStream){
    mediaStream.getTracks().forEach(t=>t.stop());
    mediaStream = null;
  }
  if(sourceNode){
    try{ sourceNode.disconnect(); }catch{}
    sourceNode = null;
  }
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // 获取选中的设备
  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  };

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  // 建 analyser
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024; // 1024 样本窗
  analyser.smoothingTimeConstant = 0.2;

  sourceNode.connect(analyser);
  // 不接到 destination，避免回授
  timeBuf = new Float32Array(analyser.fftSize);

  $("micTxt").textContent = "mic: ready";
}

function checkLoaded(){
  const ready = [
    "live",
    "happy",
    "shy",
    "sleep_in",
    "sleep_loop",
    "sleep_out",
    "listening_in",
    "listening_loop",
    "listening_out"
  ].every(n => videos[n].readyState >= 3);

  if(ready && !allLoaded){
    allLoaded = true;
    $("loading").style.display = "none";
    videos[current].play().catch(()=>{});
  }
}


//playtest2 主循环,v1.0.2
function draw(){
  if(!started){
    return;
  }

  const now = millis();
  let level = 0;

  // 1 计算音量 level 和 dB 显示
  if(analyser && timeBuf){
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for(let i=0;i<timeBuf.length;i++){
      const x = timeBuf[i];
      sum += x*x;
    }
    const rms = Math.sqrt(sum / timeBuf.length);
    level = Math.min(1, Math.max(0, rms * sens * 3));
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    $("dbTxt").textContent = `~ dB: ${isFinite(db)? db.toFixed(1): "-∞"}`;
  }else{
    level = 0;
    $("dbTxt").textContent = `~ dB: -∞`;
  }

  $("lvlTxt").textContent = `level: ${level.toFixed(3)}`;
  $("meterBar").style.width = `${Math.min(100, level*100)}%`;

  // 原本的 level 是瞬时值
  smoothLevel = smoothLevel * (1 - LEVEL_SMOOTH_ALPHA) + level * LEVEL_SMOOTH_ALPHA;


  //final submission addition, v1.0.6
  // 2 判定当前音量状态
  // 后面所有逻辑用 smoothLevel 而不是 level
  const isLoud  = smoothLevel >= LOUD_TH;
  const isSoft  = smoothLevel > SOFT_TH && smoothLevel < LOUD_TH;
  const isSilent = smoothLevel <= SOFT_TH;

   //final submission addition, v1.0.7
   // ★ 根据状态查表，设置本次最小停留时间
  if(stateHoldUntil && now < stateHoldUntil){
    // 在锁定时间内，不接受新触发，不切状态
    $("stateTxt").textContent = `state: ${current}`;
    return;
  }


  // 任何一次有效声音或点击, 都可以认为角色被打扰过
  if(level > SOFT_TH){
    lastInputAt = now;
  }

  // 轻音触发倾听的候选计时, 只在 live 或刚从别的状态回来的时候生效
  if(!isSleepState() && !isListeningState()){
    if(isSoft){
      if(listeningCandidateSince === 0){
        listeningCandidateSince = now;
      }
    }else{
      listeningCandidateSince = 0;
    }
  }

  // 倾听中安静的计时
  if(current === "listening_loop"){
    if(isSilent){
      if(listeningQuietSince === 0){
        listeningQuietSince = now;
      }
    }else{
      listeningQuietSince = 0;
    }
  }else{
    listeningQuietSince = 0;
  }

  // 2 特殊状态优先处理, 防止闪帧
  // 入睡中, 醒来中, 倾听进出场时, 不允许其他状态抢占
  if(current === "sleep_in" ||
     current === "sleep_out" ||
     current === "listening_in" || 
     current === "listening_out"
    ){
      $("stateTxt").textContent = `state: ${current}`;
      return;
    }

  // 睡眠循环里只处理唤醒逻辑
  if(current === "sleep_loop"){
    //final submission addition, v1.0.8
    // 只能被“大声”吵醒 且醒来先变害羞
    if(isLoud){
      requestWake("shy");
    }
    $("stateTxt").textContent = `state: ${current}`;
    return;
  }

  // 倾听循环里只处理退出逻辑
  if(current === "listening_loop"){
    if(isLoud){
      // 大声时会害羞, 先退出倾听再 shy
      requestListeningExit("shy");
    }else if(listeningQuietSince > 0 &&
             (now - listeningQuietSince) > LISTEN_QUIET_MS){
      // 安静一段时间, 退出倾听回 live
      requestListeningExit("live");
    }
    $("stateTxt").textContent = `state: ${current}`;
    return;
  }

  // 3 正常清醒状态优先级
  // Shy > Happy > Listening > Sleep > Live

  if(isLoud){
    shyUntil = now + SHY_HOLD_MS;
    switchTo("shy");

  }else if(now < shyUntil){
    switchTo("shy");

  }else if(now < happyUntil){
    switchTo("happy");

  }else if(listeningCandidateSince > 0 &&
           (now - listeningCandidateSince) > LISTEN_TRIGGER_MS &&
           current === "live" &&
           (now - lastListeningEndAt) > LISTEN_COOLDOWN_MS ){
    // 轻音持续一小段时间, 从 live 进入倾听
     requestListeningEnter();

  }else if((now - lastInputAt) > SLEEP_AFTER_MS){
    // 很久没有任何声音或互动, 进入入睡动画
    switchTo("sleep_in");

  }else{
    switchTo("live");
  }

  $("stateTxt").textContent = `state: ${current}`;

  maybeShowPrompt(now); // final submission addition，v1.0.6
}



//final submission addition, v1.0.8
function isSleepState(){
  return current === "sleep_in" ||
         current === "sleep_loop" ||
         current === "sleep_out";
}

function triggerHappy(){
  // 1. 睡觉相关状态禁止触发 happy
  if(isSleepState()){
    return;
  }

  // 2. 如果当前状态还在锁定时间内，也不打断
  const now = millis();
  if(stateHoldUntil && now < stateHoldUntil){
    return;
  }

  // 3. 正常 happy 逻辑
  const now2 = millis();
  happyUntil = now2 + HAPPY_HOLD_MS;
  switchTo("happy");
}


function isListeningState(){
  return current === "listening_in" ||
         current === "listening_loop" ||
         current === "listening_out";
}

// 睡眠唤醒的请求, 你之前应该已经有, 这里给一个参考版
function requestWake(target){
  if(current !== "sleep_loop") return;
  wakeTarget = target || "live";
  switchTo("sleep_out");
}

function onSleepInEnded(){
  if(current === "sleep_in"){
    switchTo("sleep_loop");
  }
}

function onSleepOutEnded(){
  if(current === "sleep_out"){
    const target = wakeTarget || "live";
    wakeTarget = null;
    const now = millis();
    lastInputAt = now;
    if(target === "happy"){
      happyUntil = now + HAPPY_HOLD_MS;
      switchTo("happy");
    }else if(target === "shy"){
      shyUntil = now + SHY_HOLD_MS;
      switchTo("shy");
    }else{
      switchTo("live");
    }
  }
}

// 倾听进出场
function requestListeningEnter(){
  if(current !== "live") return;
  listeningCandidateSince = 0;
  switchTo("listening_in");
}

//final submission addition, v1.0.7
// 倾听退出
function requestListeningExit(target){
  if(current !== "listening_loop") return;

  listeningTarget = target || "live";
  listeningQuietSince = 0;

  // 记录本次聆听结束的时间（用于 cooldown）
  lastListeningEndAt = millis();

  switchTo("listening_out");
}


function onListeningInEnded(){
  if(current === "listening_in"){
    switchTo("listening_loop");
  }
}

function onListeningOutEnded(){
  if(current === "listening_out"){
    const target = listeningTarget || "live";
    listeningTarget = null;
    const now = millis();
    lastInputAt = now;
    if(target === "happy"){
      happyUntil = now + HAPPY_HOLD_MS;
      switchTo("happy");
    }else if(target === "shy"){
      shyUntil = now + SHY_HOLD_MS;
      switchTo("shy");
    }else{
      switchTo("live");
    }
  }
}


// 只允许在 “sleep_loop” 状态时申请醒来
function requestWake(target){
  if(current !== "sleep_loop") return;
  wakeTarget = target || "live";
  switchTo("sleep_out");   // 播放醒来动画视频
}

// 入睡视频结束后自动切到循环睡眠
function onSleepInEnded(){
  if(current === "sleep_in"){
    switchTo("sleep_loop");
  }
}

// 醒来视频结束后，根据 wakeTarget 决定去哪里
function onSleepOutEnded(){
  if(current === "sleep_out"){
    handleWakeTarget();
  }
}

function handleWakeTarget(){
  const now = millis();
  const target = wakeTarget || "live";
  wakeTarget = null;

  if(target === "happy"){
    happyUntil = now + HAPPY_HOLD_MS;
    switchTo("happy");
  }else if(target === "shy"){
    shyUntil = now + SHY_HOLD_MS;
    switchTo("shy");
  }else{
    switchTo("live");
  }
}


async function toggleMute(){
  if(!started){
    // 尚未启动就先启动，避免用户误触
    await startAll();
  }
  setMuted(!isMuted);
}

function setMuted(on){
  isMuted = on;
  const btn = $("muteBtn");

  if(isMuted){
    // 停掉采集流与分析器
    if(mediaStream){
      mediaStream.getTracks().forEach(t=>t.stop());
      mediaStream = null;
    }
    if(sourceNode){
      try{ sourceNode.disconnect(); }catch{}
      sourceNode = null;
    }
    analyser = null; // draw 将读不到音量
    $("meterBar").style.width = "0%";
    $("micTxt").textContent = "mic: muted";
    btn.textContent = "Unmute Mic";
    btn.classList.add("muted");
  }else{
    // 重新按当前选择的设备开启
    startMicWithDevice(($("micSelect").value || undefined))
      .then(()=>{
        $("micTxt").textContent = "mic: ready";
      })
      .catch((err)=>{
        console.error(err);
        $("micTxt").textContent = "mic: error";
      });
    btn.textContent = "Mute Mic";
    btn.classList.remove("muted");
  }
}

//新版视频切换函数，v1.0.3
function switchTo(name){
  if(!videos[name]) return;
  if(current === name) return;   // 同一个状态不用切

  //final submission addition, v1.0.6
  // 防止切换过快
  const now = millis();
  if(now - lastStateChangeAt < MIN_STATE_INTERVAL_MS){
    return; // 切换过快，忽略
  }
  lastStateChangeAt = now;


  current = name;

   //final submission addition, v1.0.7
   // ★ 根据状态查表，设置本次最小停留时间
  const hold = STATE_MIN_HOLD[name] || 0;
  if(hold > 0){
    stateHoldUntil = millis() + hold;
  }else{
    stateHoldUntil = 0;  // 对 live / 各种 loop 不锁定
  }

  // 1. 把所有视频先暂停并变透明
  for(const key in videos){
    const v = videos[key];
    if(!v) continue;
    v.pause();
    v.style.opacity = "0";
  }

  // 2. 目标视频从头开始播放，并渐显出来
  const target = videos[name];

  try{
    target.currentTime = 0;      // 跳回第一帧
  }catch(e){
    // 某些浏览器 metadata 未加载完会报错，忽略
  }

  // 先变成不透明，这时候还会是第一帧（或上一次的第一帧），然后开始播放
  target.style.opacity = "1";

  const p = target.play();
  if(p && p.catch){
    p.catch(()=>{});             // autoplay 被拦截就忽略
  }
  //playtest2 BGM 系统, v1.0.4 
  // ★ 在这里同步更新 BGM
  updateBgmForState(name);
}

//playtest2 BGM 系统,v1.0.4
// 根据状态名，决定用哪一首 BGM
function bgmKeyForState(stateName){
  // 只有 happy 有 BGM
  if(stateName === "happy") return "happy";

  // 只有 sleep_loop 有 BGM
  if(stateName === "sleep_loop") return "sleep";

  // 其他状态都不要 BGM
  return null;
}

// 对外接口：状态变化时调用它
function updateBgmForState(stateName){
  const key = bgmKeyForState(stateName);  // "happy" / "sleep" / null
  playBgm(key);
}

// 交叉淡入淡出 BGM
// targetKey 可以是 "happy" / "sleep" / null（null 表示淡出到完全无 BGM）
function playBgm(targetKey){
  const prevKey   = currentBgmKey;
  if(targetKey === prevKey){
    // 目标和当前一样，就不用切
    return;
  }

  const prevAudio = prevKey   ? bgm[prevKey]   : null;
  const nextAudio = targetKey ? bgm[targetKey] : null;

  const fadeDuration = bgmFadeMs;
  const startTime    = performance.now();

  // 启动新 BGM
  if(nextAudio){
    try{ nextAudio.currentTime = 0; }catch(e){}
    nextAudio.volume = 0;
    nextAudio.play();
  }

  // 取消上一次的淡入淡出动画
  if(bgmFadeRaf){
    cancelAnimationFrame(bgmFadeRaf);
    bgmFadeRaf = null;
  }

  function step(now){
    const t = Math.min(1, (now - startTime) / fadeDuration);

    // 旧 BGM 音量从 1 → 0
    if(prevAudio){
      prevAudio.volume = 1 - t;
    }
    // 新 BGM 音量从 0 → 1
    if(nextAudio){
      nextAudio.volume = t;
    }

    if(t < 1){
      bgmFadeRaf = requestAnimationFrame(step);
    }else{
      // 淡入淡出结束
      if(prevAudio){
        prevAudio.pause();
        prevAudio.currentTime = 0;
      }
      currentBgmKey = targetKey || null;
      bgmFadeRaf = null;
    }
  }

  // 如果没有任何 BGM（例如从无 BGM 切到无 BGM），直接清理掉
  if(!prevAudio && !nextAudio){
    currentBgmKey = null;
    return;
  }

  bgmFadeRaf = requestAnimationFrame(step);
}




async function resumeAudio(){
  try{
    if(!audioCtx) return;
    if(audioCtx.state !== "running"){
      await audioCtx.resume();
      $("micTxt").textContent = "mic: resumed";
    }
  }catch{}
}

// 2 秒校准：测环境噪声，动态设置门限
async function calibrate2s(){
  if(!analyser) return;
  $("calBtn").disabled = true;
  $("micTxt").textContent = "mic: calibrating…";

  const start = millis();
  const samples = [];
  while(millis() - start < 2000){
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for(let i=0;i<timeBuf.length;i++){ sum += timeBuf[i]*timeBuf[i]; }
    const rms = Math.sqrt(sum / timeBuf.length);
    samples.push(rms);
    await new Promise(r=>setTimeout(r, 30));
  }
  const mean = samples.reduce((a,b)=>a+b,0) / samples.length;
  const std  = Math.sqrt(samples.reduce((s,x)=>s + (x-mean)*(x-mean),0)/samples.length);

  // 软门 = 均值 + 2σ；大声 = 软门 * 4
  SOFT_TH = clamp((mean + 2*std) * 3 * sens, 0.005, 0.08);
  LOUD_TH = clamp(SOFT_TH * 4, 0.08, 0.4);

  $("softTH").value = SOFT_TH.toFixed(3);
  $("loudTH").value = LOUD_TH.toFixed(2);
  $("micTxt").textContent = `mic: calibrated (soft ${SOFT_TH.toFixed(3)} / loud ${LOUD_TH.toFixed(2)})`;

  $("calBtn").disabled = false;
}

function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }


//playtest2 设置弹窗
function openSettings(){
  const el = $("settingsOverlay");
  if(el) el.classList.add("active");
}

function closeSettings(){
  const el = $("settingsOverlay");
  if(el) el.classList.remove("active");
}

function openHelp(){
  const el = $("helpOverlay");
  if(el) el.classList.add("active");
}

function closeHelp(){
  const el = $("helpOverlay");
  if(el) el.classList.remove("active");
}

function openAbout(){
  const el = $("aboutOverlay");
  if(el) el.classList.add("active");
}

function closeAbout(){
  const el = $("aboutOverlay");
  if(el) el.classList.remove("active");
}