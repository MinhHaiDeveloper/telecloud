// tc-media: TeleCloud in the Windows media controls (the flyout by the volume keys, the lock screen)
// and through them the keyboard's media keys, which Windows sends to the media session in use.
//
// mpv plays the music, not a browser, so TeleCloud has no media session of its own. This helper opens a
// hidden window with TeleCloud's app id, takes the System Media Transport Controls for it and passes
// button presses back. One line per message, UTF-8, tab-separated:
//
//   stdin   aumid <id> <name> <app exe> | meta <title> <artist> <album> <cover path> | state playing|paused|stopped
//           time <position s> <duration s> | buttons <next 0/1> <previous 0/1> | clear | quit
//   stdout  ready | button play|pause|stop|next|previous | seek <s> | error <message>
//
// It ends when stdin closes, so it never outlives TeleCloud.

#include <windows.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <propkey.h>
#include <propvarutil.h>
#include <systemmediatransportcontrolsinterop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#include <cstdio>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Media;
using namespace winrt::Windows::Storage;
using namespace winrt::Windows::Storage::Streams;
using winrt::Windows::Foundation::TimeSpan;

static std::mutex outLock;
static void say(const std::string &line) {
  std::lock_guard<std::mutex> g(outLock);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static std::wstring wide(const std::string &s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

static std::vector<std::string> split(const std::string &line) {
  std::vector<std::string> parts;
  std::string cur;
  for (char c : line) {
    if (c == '\t') { parts.push_back(cur); cur.clear(); } else if (c != '\r') cur += c;
  }
  parts.push_back(cur);
  return parts;
}

static TimeSpan seconds(double s) { return TimeSpan{ static_cast<int64_t>((s < 0 ? 0 : s) * 10000000.0) }; }

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcW(h, m, w, l); }

int wmain() {
  init_apartment(apartment_type::multi_threaded);

  // the app id comes first, before the window exists, so Windows files the session under TeleCloud
  std::string first;
  {
    char buf[4096];
    if (!fgets(buf, sizeof buf, stdin)) return 0;
    first = buf;
    while (!first.empty() && (first.back() == '\n' || first.back() == '\r')) first.pop_back();
  }
  auto head = split(first);
  // "aumid <id> <display name> <app exe>": the same app id as TeleCloud's Start menu shortcut, for the whole
  // process (as Chrome does) and the window, so Windows finds the shortcut and shows its name and icon.
  // The relaunch name, icon and command are what the shell uses when it can't resolve the id itself.
  std::wstring aumid = head.size() > 1 && head[0] == "aumid" ? wide(head[1]) : L"";
  std::wstring name = head.size() > 2 ? wide(head[2]) : L"TeleCloud";
  std::wstring appExe = head.size() > 3 ? wide(head[3]) : L"";
  // TeleCloud's own main window: Windows names a media session after the process that owns the window,
  // so the controls taken for it are TeleCloud's, with its name and icon. Our hidden window is the fallback.
  HWND appWindow = head.size() > 4 ? reinterpret_cast<HWND>(static_cast<uintptr_t>(_strtoui64(head[4].c_str(), nullptr, 10))) : nullptr;
  if (!aumid.empty()) SetCurrentProcessExplicitAppUserModelID(aumid.c_str());

  WNDCLASSW wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"TeleCloudMediaControls";
  wc.hIcon = LoadIconW(wc.hInstance, MAKEINTRESOURCEW(1));
  RegisterClassW(&wc);
  // a real top-level window (the controls are tied to one), never shown, not in the taskbar
  HWND hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, name.c_str(), WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, wc.hInstance, nullptr);
  if (!hwnd) { say("error no window"); return 1; }

  if (!aumid.empty()) {
    com_ptr<IPropertyStore> store;
    if (SUCCEEDED(SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(store.put())))) {
      auto put = [&](REFPROPERTYKEY key, const std::wstring &value) {
        PROPVARIANT pv;
        if (value.empty() || FAILED(InitPropVariantFromString(value.c_str(), &pv))) return;
        store->SetValue(key, pv);
        PropVariantClear(&pv);
      };
      wchar_t self[MAX_PATH] = {};
      GetModuleFileNameW(nullptr, self, MAX_PATH);
      put(PKEY_AppUserModel_ID, aumid);
      put(PKEY_AppUserModel_RelaunchDisplayNameResource, name);
      put(PKEY_AppUserModel_RelaunchIconResource, std::wstring(self) + L",0");
      put(PKEY_AppUserModel_RelaunchCommand, appExe.empty() ? std::wstring(self) : L"\"" + appExe + L"\"");
      store->Commit();
    }
  }

  SystemMediaTransportControls smtc{ nullptr };
  auto interop = get_activation_factory<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>();
  bool onApp = false;
  if (appWindow && IsWindow(appWindow)) {
    HRESULT hr = interop->GetForWindow(appWindow, guid_of<SystemMediaTransportControls>(), put_abi(smtc));
    onApp = SUCCEEDED(hr) && smtc;
    if (!onApp) { std::ostringstream o; o << "note app window refused 0x" << std::hex << (unsigned)hr; say(o.str()); smtc = nullptr; }
  }
  if (!onApp) {
    try {
      check_hresult(interop->GetForWindow(hwnd, guid_of<SystemMediaTransportControls>(), put_abi(smtc)));
    } catch (hresult_error const &e) {
      say("error " + to_string(e.message()));
      return 1;
    }
  }
  say(onApp ? "owner app" : "owner helper");

  smtc.IsEnabled(true);
  smtc.IsPlayEnabled(true);
  smtc.IsPauseEnabled(true);
  smtc.IsStopEnabled(true);
  smtc.IsNextEnabled(false);
  smtc.IsPreviousEnabled(true);
  smtc.PlaybackStatus(MediaPlaybackStatus::Closed);

  smtc.ButtonPressed([](SystemMediaTransportControls const &, SystemMediaTransportControlsButtonPressedEventArgs const &a) {
    switch (a.Button()) {
      case SystemMediaTransportControlsButton::Play: say("button\tplay"); break;
      case SystemMediaTransportControlsButton::Pause: say("button\tpause"); break;
      case SystemMediaTransportControlsButton::Stop: say("button\tstop"); break;
      case SystemMediaTransportControlsButton::Next: say("button\tnext"); break;
      case SystemMediaTransportControlsButton::Previous: say("button\tprevious"); break;
      default: break;
    }
  });
  smtc.PlaybackPositionChangeRequested([](SystemMediaTransportControls const &, PlaybackPositionChangeRequestedEventArgs const &a) {
    std::ostringstream o;
    o << "seek\t" << (a.RequestedPlaybackPosition().count() / 10000000.0);
    say(o.str());
  });

  // stdin on its own thread; the window's message loop keeps the controls alive on this one
  DWORD mainThread = GetCurrentThreadId();
  std::thread reader([&, mainThread]() {
    init_apartment(apartment_type::multi_threaded);
    std::string line;
    char buf[8192];
    double duration = 0;
    while (fgets(buf, sizeof buf, stdin)) {
      line = buf;
      while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
      auto p = split(line);
      try {
        if (p[0] == "quit") break;
        if (p[0] == "meta" && p.size() >= 5) {
          auto du = smtc.DisplayUpdater();
          du.ClearAll();
          du.Type(MediaPlaybackType::Music);
          du.MusicProperties().Title(wide(p[1]));
          du.MusicProperties().Artist(wide(p[2]));
          du.MusicProperties().AlbumTitle(wide(p[3]));
          if (!p[4].empty()) {
            try {
              auto file = StorageFile::GetFileFromPathAsync(wide(p[4])).get();
              du.Thumbnail(RandomAccessStreamReference::CreateFromFile(file));
            } catch (...) { /* no cover */ }
          }
          du.Update();
        } else if (p[0] == "state" && p.size() >= 2) {
          smtc.PlaybackStatus(p[1] == "playing" ? MediaPlaybackStatus::Playing : p[1] == "paused" ? MediaPlaybackStatus::Paused : MediaPlaybackStatus::Stopped);
        } else if (p[0] == "time" && p.size() >= 3) {
          double pos = atof(p[1].c_str());
          duration = atof(p[2].c_str());
          SystemMediaTransportControlsTimelineProperties t;
          t.StartTime(seconds(0));
          t.MinSeekTime(seconds(0));
          t.EndTime(seconds(duration));
          t.MaxSeekTime(seconds(duration));
          t.Position(seconds(pos < duration || duration <= 0 ? pos : duration));
          smtc.UpdateTimelineProperties(t);
        } else if (p[0] == "buttons" && p.size() >= 3) {
          smtc.IsNextEnabled(p[1] == "1");
          smtc.IsPreviousEnabled(p[2] == "1");
        } else if (p[0] == "clear") {
          smtc.DisplayUpdater().ClearAll();
          smtc.DisplayUpdater().Update();
          smtc.PlaybackStatus(MediaPlaybackStatus::Closed);
        }
      } catch (hresult_error const &e) {
        say("error " + to_string(e.message()));
      }
    }
    PostThreadMessageW(mainThread, WM_QUIT, 0, 0);
  });

  say("ready");
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  reader.join();
  smtc.IsEnabled(false);
  DestroyWindow(hwnd);
  return 0;
}
