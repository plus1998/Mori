import 'dart:ui';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:go_router/go_router.dart';

import '../theme/eco_adaptive_icons.dart';
import '../theme/eco_theme.dart';
import 'allow_native_platform_view.dart';
import 'eco_pressable.dart';

const adaptiveNavBarHeight = 56.0;
const adaptiveNavHorizontalPadding = 16.0;

/// Native iOS 26 UITabBar intrinsic content height (home indicator handled by native).
const adaptiveNavBarNativeHeight = 50.0;

/// Lift tab bar slightly above the screen edge (above home-indicator strip).
const adaptiveNavBottomLift = 10.0;

/// Floating capsule height for iOS < 26 frosted tabs.
const adaptiveNavBarCapsuleHeight = 64.0;

/// Compact Android segmented capsule (width + height distinct from iOS).
const adaptiveNavBarAndroidHeight = 52.0;
const adaptiveNavBarAndroidMaxWidth = 200.0;
const adaptiveNavIconSize = 22.0;
const adaptiveNavAndroidIconSize = 18.0;
const adaptiveNavLabelSize = 11.0;
const adaptiveNavAndroidLabelSize = 11.0;

/// Inset of the selected segment pill from the outer capsule edge (Android).
const adaptiveNavSegmentInset = 3.5;

double adaptiveNavBarTotalHeight(BuildContext context) {
  final safeBottom = MediaQuery.paddingOf(context).bottom;
  if (PlatformInfo.isIOS26OrHigher()) {
    return adaptiveNavBarNativeHeight + safeBottom + adaptiveNavBottomLift;
  }
  final capsuleHeight = PlatformInfo.isAndroid
      ? adaptiveNavBarAndroidHeight
      : adaptiveNavBarCapsuleHeight;
  return capsuleHeight +
      adaptiveNavBottomLift +
      (safeBottom > 0 ? safeBottom : 0);
}

double adaptiveNavOverlayInset(BuildContext context) {
  return adaptiveNavBarTotalHeight(context) + 8;
}

class AdaptiveNavDestination {
  const AdaptiveNavDestination({
    required this.icon,
    required this.label,
    this.selectedIcon,
  });

  final IconData icon;
  final IconData? selectedIcon;
  final String label;
}

class AdaptiveNavBar extends StatelessWidget {
  const AdaptiveNavBar({
    super.key,
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
  });

  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<AdaptiveNavDestination> destinations;

  @override
  Widget build(BuildContext context) {
    final router = GoRouter.maybeOf(context);
    if (router != null) {
      return ListenableBuilder(
        listenable: router.routerDelegate,
        builder: (context, _) => _buildBody(context),
      );
    }
    return _buildBody(context);
  }

  Widget _buildBody(BuildContext context) {
    final eco = ecoColors(context);
    final navDestinations = [
      for (final destination in destinations)
        AdaptiveNavigationDestination(
          icon: adaptivePlatformIcon(destination.icon),
          label: destination.label,
          selectedIcon: destination.selectedIcon == null
              ? null
              : adaptivePlatformIcon(destination.selectedIcon!),
        ),
    ];

    final tabBar = _buildTabBar(
      context: context,
      eco: eco,
      destinations: navDestinations,
    );

    final bottomInset = PlatformInfo.isIOS26OrHigher()
        ? adaptiveNavBottomLift
        : MediaQuery.paddingOf(context).bottom + adaptiveNavBottomLift;

    final navContent = PlatformInfo.isAndroid
        ? Align(
            alignment: Alignment.bottomCenter,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: adaptiveNavBarAndroidMaxWidth * destinations.length / 2,
              ),
              child: tabBar,
            ),
          )
        : tabBar;

    return Padding(
      padding: EdgeInsets.fromLTRB(
        adaptiveNavHorizontalPadding,
        0,
        adaptiveNavHorizontalPadding,
        bottomInset,
      ),
      child: navContent,
    );
  }

  Widget _buildTabBar({
    required BuildContext context,
    required EcoColors eco,
    required List<AdaptiveNavigationDestination> destinations,
  }) {
    // iOS 26: keep native Liquid Glass UITabBar — only refine tint hierarchy.
    // Drop the UiKitView while a root route covers the shell (session swipe-back).
    if (PlatformInfo.isIOS26OrHigher()) {
      final showNative = allowNativePlatformView(context);
      if (!showNative) {
        // Preserve layout height so body insets don't jump; no platform view.
        return const SizedBox(height: adaptiveNavBarNativeHeight);
      }
      final brightness = Theme.of(context).brightness;
      return IOS26NativeTabBar(
        // Remount native tab bar when theme flips so glass style tracks brightness.
        key: ValueKey('ios26-tab-$brightness'),
        destinations: destinations,
        selectedIndex: selectedIndex,
        onTap: (index) {
          if (index != selectedIndex) {
            HapticFeedback.selectionClick();
          }
          onDestinationSelected(index);
        },
        tint: eco.accent,
        unselectedItemTint: eco.textMuted,
        showNativeView: true,
      );
    }

    // Android: solid segmented capsule (design mock).
    // iOS < 26: floating frosted capsule (native-adjacent, not liquid glass).
    void onSelect(int index) {
      if (index != selectedIndex) {
        HapticFeedback.selectionClick();
      }
      onDestinationSelected(index);
    }

    if (PlatformInfo.isAndroid) {
      return _AndroidSegmentedTabBar(
        eco: eco,
        selectedIndex: selectedIndex,
        destinations: this.destinations,
        onDestinationSelected: onSelect,
      );
    }

    return _IosFrostedCapsuleTabBar(
      eco: eco,
      selectedIndex: selectedIndex,
      destinations: this.destinations,
      onDestinationSelected: onSelect,
    );
  }
}

/// Android: compact frosted stadium capsule with inset selection pill.
class _AndroidSegmentedTabBar extends StatelessWidget {
  const _AndroidSegmentedTabBar({
    required this.eco,
    required this.selectedIndex,
    required this.destinations,
    required this.onDestinationSelected,
  });

  final EcoColors eco;
  final int selectedIndex;
  final List<AdaptiveNavDestination> destinations;
  final ValueChanged<int> onDestinationSelected;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final radius = BorderRadius.circular(adaptiveNavBarAndroidHeight / 2);
    // Pure white shell at 60% opacity. Avoid heavy BackdropFilter samples of
    // the page gray (#F2F2F7) turning the bar muddy / cool-gray.
    final surface = isDark
        ? Colors.white.withValues(alpha: 0.12)
        : const Color(0x99FFFFFF); // white @ 60%
    final borderColor = isDark
        ? Colors.white.withValues(alpha: 0.12)
        : Colors.white.withValues(alpha: 0.70);
    // Selected = cool gray (distinct from white track).
    final segmentSelected = isDark
        ? Colors.white.withValues(alpha: 0.16)
        : const Color(0xE6E5E5EA); // iOS system gray6-ish @ ~90%

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: radius,
        boxShadow: [
          BoxShadow(
            color: eco.shadowScrim.withValues(alpha: isDark ? 0.28 : 0.06),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: radius,
        child: BackdropFilter(
          // Light blur only — strong sigma re-samples page gray into the fill.
          filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
          child: ColoredBox(
            color: surface,
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: radius,
                border: Border.all(color: borderColor, width: 0.5),
              ),
              child: SizedBox(
                height: adaptiveNavBarAndroidHeight,
                child: Row(
                  children: [
                    for (var i = 0; i < destinations.length; i++)
                      Expanded(
                        child: _AndroidSegmentTabItem(
                          destination: destinations[i],
                          selected: selectedIndex == i,
                          selectedFill: segmentSelected,
                          onTap: () => onDestinationSelected(i),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AndroidSegmentTabItem extends StatelessWidget {
  const _AndroidSegmentTabItem({
    required this.destination,
    required this.selected,
    required this.selectedFill,
    required this.onTap,
  });

  final AdaptiveNavDestination destination;
  final bool selected;
  final Color selectedFill;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final color = selected ? eco.accent : eco.textMuted;
    final icon = selected
        ? (destination.selectedIcon ?? destination.icon)
        : destination.icon;
    final pillRadius = BorderRadius.circular(
      (adaptiveNavBarAndroidHeight - adaptiveNavSegmentInset * 2) / 2,
    );

    return EcoPressable(
      onTap: onTap,
      scale: 0.96,
      child: Padding(
        padding: const EdgeInsets.all(adaptiveNavSegmentInset),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          decoration: BoxDecoration(
            color: selected ? selectedFill : Colors.transparent,
            borderRadius: pillRadius,
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                switchInCurve: Curves.easeOutCubic,
                switchOutCurve: Curves.easeInCubic,
                child: Icon(
                  icon,
                  key: ValueKey('${icon.codePoint}-$selected'),
                  size: adaptiveNavAndroidIconSize,
                  color: color,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                destination.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontSize: adaptiveNavAndroidLabelSize,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                  letterSpacing: 0.05,
                  height: 1.05,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Pre-iOS 26: translucent frosted capsule (unchanged iOS chrome).
class _IosFrostedCapsuleTabBar extends StatelessWidget {
  const _IosFrostedCapsuleTabBar({
    required this.eco,
    required this.selectedIndex,
    required this.destinations,
    required this.onDestinationSelected,
  });

  final EcoColors eco;
  final int selectedIndex;
  final List<AdaptiveNavDestination> destinations;
  final ValueChanged<int> onDestinationSelected;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final radius = BorderRadius.circular(adaptiveNavBarCapsuleHeight / 2);

    return ClipRRect(
      borderRadius: radius,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: radius,
            color: isDark ? const Color(0xCC1C1C1E) : const Color(0xE6F2F2F7),
            border: Border.all(
              color: isDark
                  ? Colors.white.withValues(alpha: 0.08)
                  : Colors.white.withValues(alpha: 0.65),
              width: 0.5,
            ),
            boxShadow: [
              BoxShadow(
                color: eco.shadowScrim.withValues(alpha: isDark ? 0.35 : 0.08),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: SizedBox(
            height: adaptiveNavBarCapsuleHeight,
            child: Row(
              children: [
                for (var i = 0; i < destinations.length; i++)
                  Expanded(
                    child: _IosCapsuleTabItem(
                      destination: destinations[i],
                      selected: selectedIndex == i,
                      onTap: () => onDestinationSelected(i),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _IosCapsuleTabItem extends StatelessWidget {
  const _IosCapsuleTabItem({
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  final AdaptiveNavDestination destination;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final color = selected ? eco.accent : eco.textMuted;
    final icon = selected
        ? (destination.selectedIcon ?? destination.icon)
        : destination.icon;

    return EcoPressable(
      onTap: onTap,
      scale: 0.94,
      child: SizedBox.expand(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              child: Icon(
                icon,
                key: ValueKey('${icon.codePoint}-$selected'),
                size: adaptiveNavIconSize,
                color: color,
              ),
            ),
            const SizedBox(height: 3),
            Text(
              destination.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: color,
                fontSize: adaptiveNavLabelSize,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                letterSpacing: 0.05,
                height: 1.05,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
