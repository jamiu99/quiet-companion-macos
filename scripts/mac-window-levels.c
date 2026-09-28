// Verification helper (macOS): prints every window with its CoreGraphics window level, so the companion window's
// position between the wallpaper and app windows can be checked without a screenshot (screencapture only shows the
// wallpaper when the caller lacks Screen Recording permission, e.g. from an agent/ssh shell).
//   clang -O1 -o /tmp/winlist scripts/mac-window-levels.c -framework CoreGraphics -framework CoreFoundation
//   /tmp/winlist            # all windows
//   /tmp/winlist onscreen   # on-screen windows only, listed front → back (real z-order)
// Expected for layer 'desktop': Electron 1470x956 window between 访达 desktop icons (-2147483603) and 程序坞/墙纸 (-21474836xx).
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
static void str(CFDictionaryRef d, CFStringRef k, char* buf, size_t n){ buf[0]=0; CFStringRef s=CFDictionaryGetValue(d,k); if(s) CFStringGetCString(s,buf,n,kCFStringEncodingUTF8); }
static long num(CFDictionaryRef d, CFStringRef k){ long v=-1; CFNumberRef n=CFDictionaryGetValue(d,k); if(n) CFNumberGetValue(n,kCFNumberLongType,&v); return v; }
int main(int argc,char**argv){
  CFArrayRef list = CGWindowListCopyWindowInfo(argc>1 ? (kCGWindowListOptionOnScreenOnly) : kCGWindowListOptionAll, kCGNullWindowID);
  for (CFIndex i=0;i<CFArrayGetCount(list);i++){
    CFDictionaryRef w = CFArrayGetValueAtIndex(list,i);
    CGRect r; CGRectMakeWithDictionaryRepresentation(CFDictionaryGetValue(w,kCGWindowBounds),&r);
    if (r.size.width<50||r.size.height<50) continue;
    char owner[128], name[128]; str(w,kCGWindowOwnerName,owner,128); str(w,kCGWindowName,name,128);
    CFBooleanRef on = CFDictionaryGetValue(w,kCGWindowIsOnscreen);
    printf("%-24s pid=%-6ld layer=%-12ld onscreen=%d alpha=%ld bounds=%.0f,%.0f %.0fx%.0f id=%ld name=%s\n", owner, num(w,kCGWindowOwnerPID), num(w,kCGWindowLayer), on&&CFBooleanGetValue(on), num(w,kCGWindowAlpha), r.origin.x,r.origin.y,r.size.width,r.size.height, num(w,kCGWindowNumber), name);
  }
  return 0;
}
