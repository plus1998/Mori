import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/scheduling_models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../threads/thread_providers.dart';

final schedulingSnapshotProvider =
    FutureProvider.autoDispose<SchedulingSnapshot>((ref) async {
      final rpc = ref.watch(desktopRpcProvider);
      ref.listen(ecoEventsProvider, (_, next) {
        if (next.valueOrNull?.kind == 'scheduling.changed') {
          ref.invalidateSelf();
        }
      });
      ref.listen(connectionStatusProvider, (previous, next) {
        if (previous?.valueOrNull?.state != next.valueOrNull?.state) {
          ref.invalidateSelf();
        }
      });
      if (rpc == null || !await ensureDesktopBindReady(ref)) {
        throw StateError('Desktop is not connected');
      }
      return rpc.listSchedules();
    });
