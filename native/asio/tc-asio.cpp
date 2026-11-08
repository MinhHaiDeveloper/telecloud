// tc-asio: plays DSD files natively through an ASIO driver, bit for bit, for TeleCloud.
// Everything PCM stays with mpv; this program only ever sends raw DSD.
//
// Talks over stdin/stdout, one JSON object per line.
//   in:  {"cmd":"list"} {"cmd":"probe","driver":"..."}
//        {"cmd":"play","driver":"...","path":"...","kind":"dsf|dff","rate":N,"channels":N,"dataStart":N,
//         "blockSize":N,"bytes":N,"lsbFirst":true,"start":seconds,"id":N}
//        {"cmd":"queue", same as play without driver/start}   (gapless: same rate and channels only)
//        {"cmd":"pause"} {"cmd":"resume"} {"cmd":"seek","sec":N} {"cmd":"stop"} {"cmd":"quit"}
//   out: {"ev":"drivers","names":[...]} {"ev":"probe",...} {"ev":"started",...} {"ev":"pos","sec":N,"id":N}
//        {"ev":"advanced","id":N} {"ev":"ended","id":N} {"ev":"stopped"} {"ev":"error","msg":"..."}
//
// The driver called "TeleCloud test output" is not ASIO: it plays in real time into files named by
// TC_ASIO_TEST_OUT, so the whole path can be checked without hardware.
//
// Licence: GPL-3.0, like TeleCloud. Uses the Steinberg ASIO SDK under its GPL-3.0 option.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <stdio.h>
#include <stdint.h>
#include <string>
#include <vector>
#include <atomic>
#include <mutex>
#include <thread>
#include <deque>
#include <condition_variable>
#include <mmdeviceapi.h>
#include "asiosys.h"
#include "asio.h"
#include "asiodrivers.h"

extern AsioDrivers* asioDrivers;
bool loadAsioDriver(char* name);

static const char* TEST_DRIVER = "TeleCloud test output";
static const uint8_t DSD_SILENCE = 0x69; // "no signal" in DSD: zeros would be a full-scale step

// ---------- output, one line at a time from any thread
static std::mutex outLock;
static void emit(const std::string& line) {
  std::lock_guard<std::mutex> g(outLock);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
static std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
static void error(const std::string& msg) { emit("{\"ev\":\"error\",\"msg\":" + jstr(msg) + "}"); }

// ---------- the smallest JSON reading these commands need
static size_t findKey(const std::string& j, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = j.find(k);
  if (p == std::string::npos) return p;
  p = j.find(':', p + k.size());
  if (p == std::string::npos) return p;
  p++;
  while (p < j.size() && (j[p] == ' ' || j[p] == '\t')) p++;
  return p;
}
static std::string getStr(const std::string& j, const char* key) {
  size_t p = findKey(j, key);
  if (p == std::string::npos || j[p] != '"') return "";
  std::string o;
  for (p++; p < j.size() && j[p] != '"'; p++) {
    if (j[p] != '\\') { o += j[p]; continue; }
    p++;
    if (p >= j.size()) break;
    char c = j[p];
    if (c == 'n') o += '\n'; else if (c == 't') o += '\t'; else if (c == 'r') o += '\r';
    else if (c == 'u' && p + 4 < j.size()) {
      unsigned v = strtoul(j.substr(p + 1, 4).c_str(), nullptr, 16);
      p += 4;
      if (v < 0x80) o += (char)v;
      else if (v < 0x800) { o += (char)(0xC0 | (v >> 6)); o += (char)(0x80 | (v & 0x3F)); }
      else { o += (char)(0xE0 | (v >> 12)); o += (char)(0x80 | ((v >> 6) & 0x3F)); o += (char)(0x80 | (v & 0x3F)); }
    } else o += c;
  }
  return o;
}
static double getNum(const std::string& j, const char* key, double def = 0) {
  size_t p = findKey(j, key);
  if (p == std::string::npos) return def;
  if (j.compare(p, 4, "true") == 0) return 1;
  if (j.compare(p, 5, "false") == 0) return 0;
  return strtod(j.c_str() + p, nullptr);
}
static std::wstring wide(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n ? n - 1 : 0, L'\0');
  if (n) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
  return w;
}

// ---------- a DSD file, read as bytes per channel in time order
static uint8_t REVERSE[256];
struct Track {
  int id = 0;
  std::wstring path;
  bool dsf = true;
  double rate = 0;
  int channels = 0;
  int64_t dataStart = 0;
  int blockSize = 4096;
  int64_t bytes = 0; // per channel
  bool lsbFirst = true;
};
static Track parseTrack(const std::string& j) {
  Track t;
  t.id = (int)getNum(j, "id");
  t.path = wide(getStr(j, "path"));
  t.dsf = getStr(j, "kind") != "dff";
  t.rate = getNum(j, "rate");
  t.channels = (int)getNum(j, "channels");
  t.dataStart = (int64_t)getNum(j, "dataStart");
  t.blockSize = (int)getNum(j, "blockSize", 4096);
  t.bytes = (int64_t)getNum(j, "bytes");
  t.lsbFirst = getNum(j, "lsbFirst", 1) != 0;
  return t;
}

class Reader {
public:
  ~Reader() { close(); }
  bool open(const Track& t) {
    close();
    track = t;
    f = _wfopen(t.path.c_str(), L"rb");
    return f != nullptr;
  }
  void close() { if (f) fclose(f); f = nullptr; }
  // `count` bytes of each channel from `from`, into out[c]; returns how many there were
  int64_t read(int64_t from, int64_t count, std::vector<std::vector<uint8_t>>& out) {
    if (from >= track.bytes) return 0;
    if (from + count > track.bytes) count = track.bytes - from;
    const int ch = track.channels;
    for (int c = 0; c < ch; c++) out[c].resize((size_t)count);
    if (track.dsf) {
      const int64_t bs = track.blockSize;
      int64_t done = 0;
      while (done < count) {
        const int64_t at = from + done;
        const int64_t block = at / bs, within = at % bs;
        const int64_t take = min(bs - within, count - done);
        for (int c = 0; c < ch; c++) {
          _fseeki64(f, track.dataStart + block * bs * ch + c * bs + within, SEEK_SET);
          fread(out[c].data() + done, 1, (size_t)take, f);
        }
        done += take;
      }
    } else {
      std::vector<uint8_t> span((size_t)(count * ch));
      _fseeki64(f, track.dataStart + from * ch, SEEK_SET);
      fread(span.data(), 1, span.size(), f);
      for (int64_t i = 0; i < count; i++) for (int c = 0; c < ch; c++) out[c][(size_t)i] = span[(size_t)(i * ch + c)];
    }
    return count;
  }
  Track track;
private:
  FILE* f = nullptr;
};

// ---------- what goes out: periods of bytes per channel, made ahead of time by a reader thread
struct Period {
  std::vector<std::vector<uint8_t>> data; // [channel][bytes]
  int track = 0;                          // which track these bytes belong to
  int64_t endByte = 0;                    // where in that track this period ends (per channel)
};

static std::mutex qLock;
static std::condition_variable qWake;
static std::deque<Period> periods;
static size_t maxPeriods = 64;
static std::atomic<bool> paused{ false };
static std::atomic<bool> running{ false };
static std::atomic<bool> readerStop{ false };
static std::atomic<int> generation{ 0 };   // bumped on seek and new track: the reader starts over
static std::atomic<int> playingTrack{ 0 };
static std::atomic<int64_t> playingByte{ 0 };
static std::atomic<bool> drained{ false };  // the reader reached the end and nothing is queued
static std::atomic<bool> endedSent{ false };
static std::atomic<bool> resetRequested{ false };

static std::mutex trackLock;
static Track current, queued;
static bool hasQueued = false;
static int64_t startByte = 0;
static long periodBytes = 0;   // bytes per channel per buffer switch
static int outChannels = 0;
static bool reverseBits = false; // the driver wants the other bit order than the file has
static double playRate = 0;

static void readerLoop() {
  Reader reader;
  int gen = -1;
  int64_t pos = 0;
  while (!readerStop) {
    {
      std::unique_lock<std::mutex> g(qLock);
      qWake.wait_for(g, std::chrono::milliseconds(20), [] { return readerStop || periods.size() < maxPeriods; });
      if (readerStop) break;
      if (periods.size() >= maxPeriods) continue;
    }
    if (gen != generation.load()) {
      std::lock_guard<std::mutex> g(trackLock);
      gen = generation.load();
      if (!reader.open(current)) { error("Could not open the file"); drained = true; continue; }
      pos = startByte;
      drained = false;
    }
    Period p;
    p.data.assign(outChannels, std::vector<uint8_t>());
    std::vector<std::vector<uint8_t>> got(reader.track.channels);
    int64_t n = reader.read(pos, periodBytes, got);
    if (n < periodBytes) {
      // end of this track: carry on into the queued one without a gap, or pad with silence
      std::lock_guard<std::mutex> g(trackLock);
      if (hasQueued && queued.rate == current.rate && queued.channels == current.channels) {
        std::vector<std::vector<uint8_t>> more(queued.channels);
        if (n > 0) {
          for (int c = 0; c < outChannels; c++) p.data[c] = got[min(c, reader.track.channels - 1)];
          p.track = reader.track.id;
          p.endByte = pos + n;
          // the rest of this period comes from the next track, marked as such
        }
        current = queued;
        hasQueued = false;
        if (!reader.open(current)) { error("Could not open the next file"); drained = true; continue; }
        pos = 0;
        if (n > 0) {
          int64_t rest = periodBytes - n;
          int64_t m = reader.read(0, rest, more);
          for (int c = 0; c < outChannels; c++) {
            auto& src = more[min(c, reader.track.channels - 1)];
            p.data[c].insert(p.data[c].end(), src.begin(), src.begin() + (size_t)m);
            p.data[c].resize((size_t)periodBytes, DSD_SILENCE);
          }
          p.track = reader.track.id; // the period that has the switch counts as the next track
          p.endByte = m;
          pos = m;
        } else continue;
      } else {
        if (n <= 0) { drained = true; std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
        for (int c = 0; c < outChannels; c++) { p.data[c] = got[min(c, reader.track.channels - 1)]; p.data[c].resize((size_t)periodBytes, DSD_SILENCE); }
        p.track = reader.track.id;
        p.endByte = pos + n;
        pos += n;
      }
    } else {
      for (int c = 0; c < outChannels; c++) p.data[c] = std::move(got[min(c, reader.track.channels - 1)]);
      p.track = reader.track.id;
      p.endByte = pos + n;
      pos += n;
    }
    if (reverseBits) for (auto& ch : p.data) for (auto& b : ch) b = REVERSE[b];
    std::lock_guard<std::mutex> g(qLock);
    if (gen == generation.load()) periods.push_back(std::move(p));
  }
}

/** One buffer switch: the next period, or silence while paused, seeking or at the end */
static void fill(std::vector<uint8_t*>& outs) {
  Period p;
  bool have = false;
  if (!paused) {
    std::lock_guard<std::mutex> g(qLock);
    if (!periods.empty()) { p = std::move(periods.front()); periods.pop_front(); have = true; }
  }
  qWake.notify_one();
  for (size_t c = 0; c < outs.size(); c++) {
    if (have && c < p.data.size()) memcpy(outs[c], p.data[c].data(), (size_t)periodBytes);
    else memset(outs[c], DSD_SILENCE, (size_t)periodBytes);
  }
  if (have) {
    if (p.track != playingTrack.load()) { playingTrack = p.track; emit("{\"ev\":\"advanced\",\"id\":" + std::to_string(p.track) + "}"); }
    playingByte = p.endByte;
  } else if (!paused && drained && !endedSent) {
    endedSent = true;
    emit("{\"ev\":\"ended\",\"id\":" + std::to_string(playingTrack.load()) + "}");
  }
}

// ---------- ASIO
static ASIODriverInfo driverInfo;
static ASIOBufferInfo bufferInfos[32];
static ASIOCallbacks callbacks;
static bool driverOpen = false;
static bool buffersMade = false;
static std::string openDriver;
static long bufferSamples = 0;
static ASIOSampleType sampleType = 0;
static bool canOutputReady = false;

static void bufferSwitch(long index, ASIOBool) {
  std::vector<uint8_t*> outs;
  for (int c = 0; c < outChannels; c++) outs.push_back((uint8_t*)bufferInfos[c].buffers[index]);
  fill(outs);
  if (canOutputReady) ASIOOutputReady();
}
static ASIOTime* bufferSwitchTimeInfo(ASIOTime* t, long index, ASIOBool direct) { bufferSwitch(index, direct); return t; }
static void sampleRateChanged(ASIOSampleRate) { resetRequested = true; }
static long asioMessage(long selector, long value, void*, double*) {
  switch (selector) {
    case kAsioSelectorSupported:
      return value == kAsioResetRequest || value == kAsioEngineVersion || value == kAsioResyncRequest || value == kAsioLatenciesChanged;
    case kAsioResetRequest: resetRequested = true; return 1;
    case kAsioResyncRequest: return 1;
    case kAsioLatenciesChanged: return 1;
    case kAsioEngineVersion: return 2;
    default: return 0;
  }
}

static void closeDriver() {
  if (buffersMade) { ASIOStop(); ASIODisposeBuffers(); buffersMade = false; }
  if (driverOpen) {
    ASIOIoFormat pcm = { kASIOPCMFormat };
    ASIOFuture(kAsioSetIoFormat, &pcm); // leave it as other programs expect it
    ASIOExit();
    driverOpen = false;
  }
  if (asioDrivers) asioDrivers->removeCurrentDriver();
  openDriver.clear();
}

static std::string openAsio(const std::string& name) {
  if (driverOpen && openDriver == name) return "";
  closeDriver();
  std::vector<char> n(name.begin(), name.end());
  n.push_back(0);
  if (!loadAsioDriver(n.data())) return "Could not load the ASIO driver";
  memset(&driverInfo, 0, sizeof driverInfo);
  driverInfo.asioVersion = 2;
  driverInfo.sysRef = GetConsoleWindow();
  if (ASIOInit(&driverInfo) != ASE_OK) { asioDrivers->removeCurrentDriver(); return std::string("The driver could not start: ") + driverInfo.errorMessage; }
  driverOpen = true;
  openDriver = name;
  return "";
}

static bool setDsd(bool on) {
  ASIOIoFormat f = { on ? kASIODSDFormat : kASIOPCMFormat };
  return ASIOFuture(kAsioSetIoFormat, &f) == ASE_SUCCESS;
}

static void probe(const std::string& name) {
  std::string why = openAsio(name);
  if (!why.empty()) { emit("{\"ev\":\"probe\",\"driver\":" + jstr(name) + ",\"ok\":false,\"msg\":" + jstr(why) + "}"); return; }
  ASIOIoFormat can = { kASIODSDFormat };
  bool dsd = ASIOFuture(kAsioCanDoIoFormat, &can) == ASE_SUCCESS && setDsd(true);
  std::string rates = "[";
  long ins = 0, outs = 0;
  ASIOGetChannels(&ins, &outs);
  long type = -1;
  if (dsd) {
    bool first = true;
    for (int k = 1; k <= 8; k *= 2) {
      double r = 2822400.0 * k;
      if (ASIOCanSampleRate(r) == ASE_OK) { rates += (first ? "" : ",") + std::to_string((long long)r); first = false; }
    }
    ASIOChannelInfo ci = { 0, ASIOFalse };
    if (ASIOGetChannelInfo(&ci) == ASE_OK) type = ci.type;
  }
  rates += "]";
  closeDriver();
  emit("{\"ev\":\"probe\",\"driver\":" + jstr(name) + ",\"ok\":true,\"dsd\":" + (dsd ? "true" : "false") + ",\"rates\":" + rates
    + ",\"outputs\":" + std::to_string(outs) + ",\"type\":" + std::to_string(type) + "}");
}

// ---------- the test output: real time, into files
static std::thread testThread;
static std::atomic<bool> testRun{ false };
static void testLoop() {
  std::vector<FILE*> files;
  const char* base = getenv("TC_ASIO_TEST_OUT");
  for (int c = 0; c < outChannels; c++) {
    std::string p = std::string(base ? base : "tc-asio-test") + "-ch" + std::to_string(c) + ".raw";
    FILE* f = fopen(p.c_str(), "wb");
    files.push_back(f);
  }
  std::vector<std::vector<uint8_t>> bufs(outChannels, std::vector<uint8_t>((size_t)periodBytes));
  const double periodMs = periodBytes * 8.0 / playRate * 1000.0;
  auto next = std::chrono::steady_clock::now();
  while (testRun) {
    std::vector<uint8_t*> outs;
    for (auto& b : bufs) outs.push_back(b.data());
    fill(outs);
    for (int c = 0; c < outChannels; c++) if (files[c]) fwrite(bufs[c].data(), 1, (size_t)periodBytes, files[c]);
    next += std::chrono::microseconds((long long)(periodMs * 1000));
    std::this_thread::sleep_until(next);
  }
  for (auto f : files) if (f) fclose(f);
}

static std::thread readerThread;
static void stopAll() {
  if (testRun) { testRun = false; if (testThread.joinable()) testThread.join(); }
  if (buffersMade) { ASIOStop(); ASIODisposeBuffers(); buffersMade = false; }
  readerStop = true;
  qWake.notify_all();
  if (readerThread.joinable()) readerThread.join();
  readerStop = false;
  { std::lock_guard<std::mutex> g(qLock); periods.clear(); }
  running = false;
  paused = false;
  playRate = 0;
}

static void startReader() {
  { std::lock_guard<std::mutex> g(qLock); periods.clear(); }
  endedSent = false;
  drained = false;
  generation++;
  if (!readerThread.joinable()) readerThread = std::thread(readerLoop);
}

static void play(const std::string& j) {
  std::string driver = getStr(j, "driver");
  Track t = parseTrack(j);
  double start = getNum(j, "start");
  if (t.channels <= 0 || t.rate <= 0 || t.bytes <= 0) { error("Not a DSD file this can play"); return; }
  bool same = running && driver == openDriver && t.rate == playRate && t.channels == outChannels;
  if (!same) {
    stopAll();
    if (driver == TEST_DRIVER) {
      closeDriver();
      openDriver = driver;
      outChannels = t.channels;
      periodBytes = (long)(t.rate / 8 / 100) & ~3L; // 10 ms
      sampleType = ASIOSTDSDInt8LSB1;
      reverseBits = !t.lsbFirst;
    } else {
      std::string why = openAsio(driver);
      if (!why.empty()) { error(why); return; }
      ASIOIoFormat can = { kASIODSDFormat };
      if (ASIOFuture(kAsioCanDoIoFormat, &can) != ASE_SUCCESS || !setDsd(true)) { closeDriver(); error("This driver can't play DSD"); return; }
      if (ASIOCanSampleRate(t.rate) != ASE_OK) { closeDriver(); error("This driver can't play DSD at this rate"); return; }
      if (ASIOSetSampleRate(t.rate) != ASE_OK) { closeDriver(); error("The driver refused the DSD rate"); return; }
      long ins = 0, outs = 0;
      ASIOGetChannels(&ins, &outs);
      if (outs < t.channels) { closeDriver(); error("The driver has fewer outputs than the file has channels"); return; }
      long minS, maxS, pref, gran;
      ASIOGetBufferSize(&minS, &maxS, &pref, &gran);
      bufferSamples = pref;
      outChannels = t.channels;
      for (int c = 0; c < outChannels; c++) { bufferInfos[c].isInput = ASIOFalse; bufferInfos[c].channelNum = c; bufferInfos[c].buffers[0] = bufferInfos[c].buffers[1] = nullptr; }
      callbacks.bufferSwitch = bufferSwitch;
      callbacks.sampleRateDidChange = sampleRateChanged;
      callbacks.asioMessage = asioMessage;
      callbacks.bufferSwitchTimeInfo = bufferSwitchTimeInfo;
      if (ASIOCreateBuffers(bufferInfos, outChannels, bufferSamples, &callbacks) != ASE_OK) { closeDriver(); error("Could not make the ASIO buffers"); return; }
      buffersMade = true;
      ASIOChannelInfo ci = { 0, ASIOFalse };
      ASIOGetChannelInfo(&ci);
      sampleType = ci.type;
      if (sampleType != ASIOSTDSDInt8LSB1 && sampleType != ASIOSTDSDInt8MSB1) { closeDriver(); error("This driver wants a DSD layout TeleCloud doesn't send yet"); return; }
      // DSD buffers count 1-bit samples, 8 to a byte
      periodBytes = bufferSamples / 8;
      bool wantsLsb = sampleType == ASIOSTDSDInt8LSB1;
      reverseBits = wantsLsb != t.lsbFirst;
      canOutputReady = ASIOOutputReady() == ASE_OK;
    }
    playRate = t.rate;
    maxPeriods = (size_t)max(8.0, (t.rate / 8) * 1.5 / max(1L, periodBytes)); // about 1.5 s ahead
  }
  {
    std::lock_guard<std::mutex> g(trackLock);
    current = t;
    hasQueued = false;
    startByte = ((int64_t)(start * t.rate / 8)) & ~1LL;
    if (startByte >= t.bytes) startByte = 0;
  }
  playingTrack = t.id;
  playingByte = startByte;
  paused = false;
  startReader();
  // let the reader get ahead before the device asks for data
  for (int i = 0; i < 50; i++) { { std::lock_guard<std::mutex> g(qLock); if (periods.size() >= 4) break; } Sleep(5); }
  if (!same) {
    if (openDriver == TEST_DRIVER) { testRun = true; testThread = std::thread(testLoop); }
    else if (ASIOStart() != ASE_OK) { stopAll(); closeDriver(); error("The driver would not start"); return; }
    running = true;
  }
  emit("{\"ev\":\"started\",\"id\":" + std::to_string(t.id) + ",\"rate\":" + std::to_string((long long)t.rate) + ",\"type\":" + std::to_string(sampleType)
    + ",\"period\":" + std::to_string(periodBytes) + ",\"reversed\":" + (reverseBits ? "true" : "false") + "}");
}

int main() {
  for (int i = 0; i < 256; i++) { int r = 0; for (int b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b); REVERSE[i] = (uint8_t)r; }
  CoInitialize(nullptr);
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
  if (!asioDrivers) asioDrivers = new AsioDrivers();

  std::deque<std::string> commands;
  std::mutex cLock;
  std::atomic<bool> inputClosed{ false };
  std::thread input([&] {
    char line[65536];
    while (fgets(line, sizeof line, stdin)) { std::lock_guard<std::mutex> g(cLock); commands.push_back(line); }
    inputClosed = true;
  });
  emit("{\"ev\":\"ready\"}");
  auto lastPos = std::chrono::steady_clock::now();
  bool quit = false;
  while (!quit) {
    std::string cmd;
    { std::lock_guard<std::mutex> g(cLock); if (!commands.empty()) { cmd = commands.front(); commands.pop_front(); } }
    if (cmd.empty()) {
      if (inputClosed) break;
      if (resetRequested) { resetRequested = false; stopAll(); closeDriver(); error("The driver asked to be reset"); }
      if (running && std::chrono::steady_clock::now() - lastPos > std::chrono::milliseconds(100)) {
        lastPos = std::chrono::steady_clock::now();
        double sec = playRate > 0 ? playingByte.load() * 8.0 / playRate : 0;
        char b[96]; sprintf_s(b, "{\"ev\":\"pos\",\"sec\":%.3f,\"id\":%d}", sec, playingTrack.load());
        emit(b);
      }
      Sleep(5);
      continue;
    }
    std::string c = getStr(cmd, "cmd");
    if (c == "list") {
      char* names[64];
      std::vector<std::vector<char>> store(64, std::vector<char>(64));
      for (int i = 0; i < 64; i++) names[i] = store[i].data();
      long n = asioDrivers->getDriverNames(names, 64);
      std::string o = "{\"ev\":\"drivers\",\"names\":[";
      for (long i = 0; i < n; i++) o += (i ? "," : "") + jstr(names[i]);
      emit(o + "]}");
    } else if (c == "probe") {
      std::string d = getStr(cmd, "driver");
      if (d == TEST_DRIVER) emit("{\"ev\":\"probe\",\"driver\":" + jstr(d) + ",\"ok\":true,\"dsd\":true,\"rates\":[2822400,5644800,11289600,22579200],\"outputs\":8,\"type\":32}");
      else if (running) emit("{\"ev\":\"probe\",\"driver\":" + jstr(d) + ",\"ok\":false,\"msg\":\"Busy playing\"}");
      else probe(d);
    } else if (c == "play") play(cmd);
    else if (c == "queue") {
      Track t = parseTrack(cmd);
      std::lock_guard<std::mutex> g(trackLock);
      if (running && t.rate == current.rate && t.channels == current.channels) { queued = t; hasQueued = true; drained = false; emit("{\"ev\":\"queued\",\"id\":" + std::to_string(t.id) + "}"); }
      else emit("{\"ev\":\"queued\",\"id\":" + std::to_string(t.id) + ",\"refused\":true}");
    }
    else if (c == "default") {
      // the output Windows plays to by default, as "{0.0.0.00000000}.{guid}"
      std::string id;
      IMMDeviceEnumerator* en = nullptr;
      if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en))) {
        IMMDevice* d = nullptr;
        if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &d))) {
          LPWSTR w = nullptr;
          if (SUCCEEDED(d->GetId(&w))) { char b[512]; WideCharToMultiByte(CP_UTF8, 0, w, -1, b, sizeof b, nullptr, nullptr); id = b; CoTaskMemFree(w); }
          d->Release();
        }
        en->Release();
      }
      emit("{\"ev\":\"default\",\"id\":" + jstr(id) + "}");
    }
    else if (c == "pause") paused = true;
    else if (c == "resume") paused = false;
    else if (c == "seek") {
      double sec = getNum(cmd, "sec");
      { std::lock_guard<std::mutex> g(trackLock); startByte = ((int64_t)(sec * current.rate / 8)) & ~1LL; if (startByte >= current.bytes) startByte = current.bytes; hasQueued = false; }
      playingByte = startByte;
      startReader();
    }
    else if (c == "stop") { stopAll(); closeDriver(); emit("{\"ev\":\"stopped\"}"); }
    else if (c == "quit") quit = true;
  }
  stopAll();
  closeDriver();
  if (input.joinable()) input.detach();
  CoUninitialize();
  return 0;
}
