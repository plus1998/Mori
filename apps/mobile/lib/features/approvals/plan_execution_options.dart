import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/plan_execution.dart';
import '../../core/widgets/eco_modal_sheet.dart';

enum PlanExecutionAction { schedule, subagent, newSession }

class PlanExecutionSelection {
  const PlanExecutionSelection(this.action, {this.target});
  final PlanExecutionAction action;
  final PlanExecutionTarget? target;
}

Future<PlanExecutionSelection?> showPlanExecutionOptions(
  BuildContext context, {
  required List<PlanDelegationAgentOption> agents,
  required bool canSchedule,
  required bool canStartNewSession,
}) => showEcoModalBottomSheet<PlanExecutionSelection>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (_) => _PlanExecutionOptions(
    agents: agents,
    canSchedule: canSchedule,
    canStartNewSession: canStartNewSession,
  ),
);

class _PlanExecutionOptions extends StatefulWidget {
  const _PlanExecutionOptions({
    required this.agents,
    required this.canSchedule,
    required this.canStartNewSession,
  });

  final List<PlanDelegationAgentOption> agents;
  final bool canSchedule;
  final bool canStartNewSession;

  @override
  State<_PlanExecutionOptions> createState() => _PlanExecutionOptionsState();
}

class _PlanExecutionOptionsState extends State<_PlanExecutionOptions> {
  final _message = TextEditingController();
  bool _showAgents = false;

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  void _select(PlanExecutionAction action, {PlanExecutionTarget? target}) =>
      Navigator.of(context).pop(PlanExecutionSelection(action, target: target));

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final media = MediaQuery.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: media.size.height * 0.65),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 20),
            children: [
              ListTile(
                leading: _showAgents
                    ? IconButton(
                        onPressed: () => setState(() => _showAgents = false),
                        tooltip: l.commonBack,
                        icon: const Icon(Icons.arrow_back),
                      )
                    : null,
                title: Text(
                  _showAgents
                      ? l.approvalPlanDelegateTitle
                      : l.approvalPlanExecutionOptions,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (!_showAgents) ...[
                if (widget.canSchedule)
                  ListTile(
                    key: const Key('plan-execution-schedule'),
                    leading: const Icon(Icons.schedule),
                    title: Text(l.approvalPlanScheduleExecution),
                    onTap: () => _select(PlanExecutionAction.schedule),
                  ),
                if (widget.agents.any((agent) => agent.canExecutePlan))
                  ListTile(
                    key: const Key('plan-execution-subagent'),
                    leading: const Icon(Icons.group_outlined),
                    title: Text(l.approvalPlanDelegateTitle),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => setState(() => _showAgents = true),
                  ),
                if (widget.canStartNewSession)
                  ListTile(
                    key: const Key('plan-execution-new-session'),
                    leading: const Icon(Icons.add_comment_outlined),
                    title: Text(l.approvalPlanExecuteInNewSession),
                    onTap: () => _select(PlanExecutionAction.newSession),
                  ),
              ] else ...[
                for (final agent in widget.agents)
                  ListTile(
                    key: ValueKey('plan-execution-agent-${agent.agentKey}'),
                    enabled: agent.canExecutePlan,
                    title: Text(agent.displayName),
                    subtitle: !agent.canExecutePlan
                        ? Text(l.approvalPlanDelegateReadOnly)
                        : agent.displayName != agent.agentKey
                        ? Text(agent.agentKey)
                        : null,
                    onTap: agent.canExecutePlan
                        ? () => _select(
                            PlanExecutionAction.subagent,
                            target: PlanExecutionTarget.subagent(
                              agent.agentKey,
                              additionalMessage: _message.text,
                            ),
                          )
                        : null,
                  ),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: TextField(
                    key: const Key('plan-execution-additional-message'),
                    controller: _message,
                    minLines: 2,
                    maxLines: 4,
                    decoration: InputDecoration(
                      labelText: l.approvalPlanDelegateMessage,
                      hintText: l.approvalPlanDelegateMessageHint,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
