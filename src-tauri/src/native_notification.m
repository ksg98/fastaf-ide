#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

// notify-rust owns the existing center delegate. Initialize it first, then
// forward its callbacks so other Tauri plugin notifications keep working.
extern void setupDelegate(void);
extern void tuic_native_notice_clicked(const char *target);

static NSString *const TUIC_TARGET_KEY = @"tuicTarget";
static id<NSUserNotificationCenterDelegate> priorDelegate;

@protocol TUICDismissDelegate <NSObject>
- (void)userNotificationCenter:(NSUserNotificationCenter *)center
               didDismissAlert:(NSUserNotification *)notification;
@end

@interface TUICNoticeDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

@implementation TUICNoticeDelegate

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
       didActivateNotification:(NSUserNotification *)notification {
    NSString *target = notification.userInfo[TUIC_TARGET_KEY];
    if (target) {
        tuic_native_notice_clicked(target.UTF8String);
        [center removeDeliveredNotification:notification];
    } else if ([priorDelegate respondsToSelector:@selector(userNotificationCenter:didActivateNotification:)]) {
        [priorDelegate userNotificationCenter:center didActivateNotification:notification];
    }
}

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
      didDeliverNotification:(NSUserNotification *)notification {
    if ([priorDelegate respondsToSelector:@selector(userNotificationCenter:didDeliverNotification:)]) {
        [priorDelegate userNotificationCenter:center didDeliverNotification:notification];
    }
}

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
               didDismissAlert:(NSUserNotification *)notification {
    if (notification.userInfo[TUIC_TARGET_KEY]) {
        [center removeDeliveredNotification:notification];
    } else if ([priorDelegate respondsToSelector:@selector(userNotificationCenter:didDismissAlert:)]) {
        [(id<TUICDismissDelegate>)priorDelegate userNotificationCenter:center didDismissAlert:notification];
    }
}

- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
     shouldPresentNotification:(NSUserNotification *)notification {
    if (notification.userInfo[TUIC_TARGET_KEY]) return YES;
    if ([priorDelegate respondsToSelector:@selector(userNotificationCenter:shouldPresentNotification:)]) {
        return [priorDelegate userNotificationCenter:center shouldPresentNotification:notification];
    }
    return NO;
}

@end

void tuic_send_native_notification(const char *title, const char *body, const char *target) {
    @autoreleasepool {
        NSString *titleText = [NSString stringWithUTF8String:title];
        NSString *bodyText = [NSString stringWithUTF8String:body];
        NSString *targetText = [NSString stringWithUTF8String:target];
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                static TUICNoticeDelegate *delegate;
                NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
                if (!delegate) {
                    setupDelegate();
                    priorDelegate = center.delegate;
                    delegate = [TUICNoticeDelegate new];
                    center.delegate = delegate;
                }

                NSUserNotification *notification = [NSUserNotification new];
                notification.title = titleText;
                notification.informativeText = bodyText;
                notification.userInfo = @{ TUIC_TARGET_KEY: targetText };
                [center deliverNotification:notification];
            }
        });
    }
}
