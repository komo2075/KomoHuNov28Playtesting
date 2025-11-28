// ====== Tunables ======
let SLEEP_AFTER_MS = 10000;
let SHY_HOLD_MS    = 1200;
let HAPPY_HOLD_MS  = 1200;

// thresholds 可调或校准
let SOFT_TH = 0.02;
let LOUD_TH = 0.12;

let videos = {};
let current = "live";
let lastInputAt = 0;
let shyUntil = 0;
let happyUntil = 0;
let allLoaded = false;
let started = false;
let isMuted = false;   // 是否闭麦

let sens = 1.0;

// Web Audio
let audioCtx, analyser, mediaStream, sourceNode;
let timeBuf;

let wakeTarget = null;  // 从睡眠里醒来之后要去的目标状态：live/happy/shy


// UI refs
const $ = (id)=>document.getElementById(id);

function setup(){
  noCanvas();

  // build videos
  const stage = $("stage");

  // 新的所有视频名字
  const videoNames = ["live","happy","sleep_in","sleep_loop","sleep_out","shy"];

  videoNames.forEach(name=>{
    const v = document.createElement("video");
    v.id = `vid-${name}`;
    v.src = `assets/${name}.mp4`;

    // 入睡和醒来只播一次，其他循环
    if(name === "sleep_in" || name === "sleep_out"){
      v.loop = false;
    }else{
      v.loop = true;
    }

    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("webkit-playsinline","true");
    v.setAttribute("x5-playsinline","true");
    v.addEventListener("canplaythrough", checkLoaded, { once:true });

    // 监听入睡视频播完 → 切到循环睡眠
    if(name === "sleep_in"){
      v.addEventListener("ended", onSleepInEnded);
    }
    // 监听醒来视频播完 → 执行真正要去的状态
    if(name === "sleep_out"){
      v.addEventListener("ended", onSleepOutEnded);
    }

    stage.appendChild(v);
    videos[name] = v;
  });


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
  const ready = ["live","happy","sleep_in","sleep_loop","sleep_out","shy"]
    .every(n => videos[n].readyState >= 3);
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

  // ===== 1. 计算 level、更新 HUD =====
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

  // 有效输入刷新计时（如果你想靠声音控制入睡，就保留这一行）
  if(level > SOFT_TH){
    lastInputAt = now;
  }

  const isLoud = level >= LOUD_TH;
  const isSoft = level > SOFT_TH && level < LOUD_TH;

  // ===== 2. 特殊处理：sleep 三个阶段单独处理 =====

  // 2.1 正在播“入睡”动画：只等待视频播完，别乱切
  if(current === "sleep_in"){
    $("stateTxt").textContent = `state: ${current}`;
    return; // ★★ 防止被下面逻辑改成 live / happy / shy
  }

  // 2.2 睡眠循环阶段：这里只检测要不要醒
  if(current === "sleep_loop"){
    if(isLoud){
      // 大声吵醒 → 走 wake到 shy
      requestWake("shy");
    }else if(isSoft){
      // 轻声叫醒 → 醒来回 live
      requestWake("live");
    }
    $("stateTxt").textContent = `state: ${current}`;
    return; // ★★ 在睡觉时这一帧不要其它状态抢占
  }

  // 2.3 正在播“醒来”动画：等播完由 ended 回调处理
  if(current === "sleep_out"){
    $("stateTxt").textContent = `state: ${current}`;
    return; // ★★ 不要被下面逻辑覆盖
  }

  // ===== 3. 正常清醒状态的优先级逻辑：shy > happy > sleep_in > live =====

  if(isLoud){
    shyUntil = now + SHY_HOLD_MS;
    switchTo("shy");
  }else if(now < shyUntil){
    switchTo("shy");
  }else if(now < happyUntil){
    switchTo("happy");
  }else if((now - lastInputAt) > SLEEP_AFTER_MS){
    // 10 秒无互动 → 播入睡动画一次
    switchTo("sleep_in");
  }else{
    switchTo("live");
  }

  $("stateTxt").textContent = `state: ${current}`;
}



function triggerHappy(){
  const now = millis();
  lastInputAt = now;

  if(isSleepState()){
    // 在睡觉时点击 → 先醒来，再去 happy
    requestWake("happy");
  }else{
    happyUntil = now + HAPPY_HOLD_MS;
    switchTo("happy");
  }
}


//playtest2 sleep state 判断
// 入睡视频播完，切到循环睡眠
function isSleepState(){
  return current === "sleep_in" ||
         current === "sleep_loop" ||
         current === "sleep_out";
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


function switchTo(name, opts = {resetTime:true}){
  if(current === name) return;
  Object.entries(videos).forEach(([key, v])=>{
    if(key === name){
      v.style.display = "block";
      if(opts.resetTime) try{ v.currentTime = 0; }catch(e){}
      v.play().catch(()=>{});
    }else{
      v.style.display = "none";
      v.pause();
    }
  });
  current = name;
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