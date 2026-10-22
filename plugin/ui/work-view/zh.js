// Chinese display layer for the My Work page. It rewrites the page's fixed
// English labels in the browser and never touches the data or the page logic.
// Unknown text (agent-written titles, summaries) is left exactly as recorded.
const EXACT = {
  'My Work · claude-mem': '我的工作 · claude-mem',
  'Claude-Mem My Work': 'Claude-Mem 我的工作',
  'Skip to my work': '跳到我的工作',
  'My Work': '我的工作',
  'TeamBrain': '团队共享 TeamBrain',
  'Memory & settings': '记忆与设置',
  'Connecting locally…': '正在连接本机…',
  'Your workspace, at a glance': '工作总览',
  'Your requests. What landed. What needs you.': '你交代的任务：哪些已完成，哪些需要你处理。',
  'Cards': '卡片', 'List': '列表', 'Agents': '按 AI 分组',
  'Search requests and agents': '搜索任务或 AI', 'Search requests or agents': '搜索任务或 AI',
  'Project': '项目', 'All projects': '全部项目', 'Filter by project': '按项目筛选',
  'Time range': '时间范围', 'Past 24 hours': '最近 24 小时', 'Past 7 days': '最近 7 天', 'All recorded work': '全部记录',
  'Sort': '排序', 'Sort requests': '任务排序', 'Attention first': '需要处理的优先', 'Latest update': '最近更新',
  'Oldest update': '最早更新', 'Request A–Z': '按任务名 A–Z',
  'All': '全部', 'All work': '全部', 'Filter work': '按状态筛选', 'Work view': '工作视图', 'Main': '主要内容',
  'Reading saved requests from this computer…': '正在读取本机保存的任务…',
  'Reading saved requests from this computer.': '正在读取本机保存的任务。',
  'Working, reported complete, and human checked are separate states.': '“进行中”“AI 报告完成”“你已检查”是三种不同的状态。',
  'Working, reported complete, and human checked are separate states. Your review closes the loop.': '“进行中”“AI 报告完成”“你已检查”是三种不同的状态，你检查过才算闭环。',
  'Cloud sync: checking configuration…': '云同步：正在检查配置…',
  'Cloud sync not connected · optional': '云同步未连接 · 可选',
  'Cloud sync configured · local viewing remains independent': '云同步已配置 · 本机查看不受影响',
  'Cloud sync status unavailable · local viewing remains independent': '云同步状态暂不可用 · 本机查看不受影响',
  'Waiting for the local connection…': '等待本机连接…',
  'Optional connections': '可选连接',
  'Connect Claude.ai ↗': '连接 Claude.ai ↗', 'Connect ChatGPT ↗': '连接 ChatGPT ↗',
  'Live updates': '实时更新', 'Connecting to local feed': '正在连接本机数据', 'Reconnecting to local feed': '正在重连本机数据',
  'Local feed stale': '本机数据已过时',
  // Status labels
  'Needs you': '需要你', 'In progress': '进行中', 'No recent update': '久无更新', 'Ready to check': '待你检查',
  'Checked': '已检查', 'Update recorded': '有更新记录', 'Blocked': '受阻', 'Done': '已完成', 'Closed': '已关闭',
  'To do': '待办', 'Other states': '其他状态', 'Reported complete': 'AI 报告完成', 'Checked locally': '已在本机检查',
  'Tasks: Blocked': '任务：受阻', 'Tasks: In progress': '任务：进行中', 'Tasks: Needs you': '任务：需要你', 'Tasks: To do': '任务：待办',
  // Cards and detail pages
  'Open request': '打开任务', 'Next step': '下一步', 'Next': '下一步', 'Next step / outcome': '下一步 / 结果',
  'Follow the latest recorded activity.': '关注最近的记录动态。',
  'Read the handoff, then continue in the original work conversation.': '先读交接说明，再回到原来的工作对话里继续。',
  'Read the reported result and recorded evidence.': '查看 AI 报告的结果和留下的依据。',
  'No progress update has been recorded.': '尚无进展记录。',
  'No detailed update recorded.': '尚无详细更新记录。',
  'No newer progress recorded.': '没有更新的进展记录。',
  'No next step recorded yet.': '尚未记录下一步。',
  'Not recorded': '未记录', 'Not recorded yet': '尚未记录', 'Not estimated yet': '尚未估算', 'Time not recorded': '时间未记录',
  'Status not recorded': '状态未记录', 'Task status not recorded': '任务状态未记录',
  'Contributor not recorded': '未记录执行者', 'Recorded work': '已记录的工作', 'Supporting work': '配套工作',
  'Local project': '本机项目', 'Unknown project': '未知项目',
  'Just now': '刚刚', 'Yesterday': '昨天', 'Just started': '刚开始', 'Waiting to begin.': '等待开始。',
  'Back to My Work': '返回我的工作', 'Back to request': '返回任务', 'Close dialog': '关闭对话框', 'Dismiss notification': '关闭通知',
  'Request': '任务', 'Requests': '任务', 'Status': '状态', 'Contributors': '执行者', 'Contributor': '执行者',
  'Last update': '最后更新', 'Updated': '更新于', 'Update': '更新', 'Elapsed': '已用时间', 'Time to completion': '完成用时',
  'Time since the human request, not active agent runtime': '从你提出任务起算的时间，不是 AI 实际运行时长',
  'Progress': '进展', 'Result': '结果', 'Outcome': '结果', 'Finding': '发现', 'Observation': '观察',
  'Handoff': '交接说明', 'Read handoff': '查看交接说明', 'Review result': '检查结果', 'Read full original': '查看完整原文',
  'Original source': '原始记录', 'Recorded source': '已记录的来源', 'Recorded update': '已记录的更新', 'Recorded': '已记录',
  'Work update': '工作更新', 'Overlapping work': '重叠的工作', 'Missing context': '缺少背景',
  'Latest recorded updates:': '最近的记录：',
  'Open documentation': '打开文档', 'Open promotion material': '打开推广材料',
  'No matching work': '没有匹配的任务', 'No requests here yet': '这里还没有任务', 'No open tasks': '没有未完成的任务',
  'Try another request, project or contributor.': '换个任务、项目或执行者试试。',
  'Open the recorded tasks to see the work and its next steps.': '打开已记录的任务，查看工作内容和下一步。',
  'Waiting for local work': '等待本机的工作记录', 'Waiting for updates from this computer.': '等待本机的更新。',
  'Loading your local work…': '正在加载本机的工作…', 'Loading recorded source…': '正在加载原始记录…',
  'Recorded human requests appear here as your tools save work. You can also explore your existing memory below.': '你的工具保存工作后，任务会显示在这里。也可以在下方查看已有的记忆。',
  'A readable summary is being prepared from the recorded work.': '正在根据记录整理易读的摘要。',
  'A readable update is being prepared.': '正在整理易读的更新。',
  'Updates are arriving from this computer. Each card shows when its work was last updated.': '更新来自本机。每张卡片显示该任务最后一次更新的时间。',
  'Continue in the original work conversation. This handoff does not assign or send work.': '请回到原来的工作对话里继续。这份交接说明不会派发或发送任何任务。',
  'Connection status does not indicate an agent is running.': '连接状态不代表 AI 正在运行。',
  'No separate test evidence was recorded. Inspect the source before checking this result.': '没有单独记录测试依据。检查结果前请先看原始记录。',
  'This source record is no longer available.': '这条原始记录已不可用。',
  'This work changed while you were reading. Review the latest version before checking.': '你查看期间这项工作有变化，请先看最新版本再检查。',
  'You reviewed this version. New work will need a fresh check.': '你检查过这个版本。有新工作后需要重新检查。',
  'Contributing to your requests': '参与处理你的任务',
  // Review actions and notices
  'Check undone.': '已撤销检查。', 'Check undone. The result is ready to review.': '已撤销检查，结果可再次检查。',
  'Checked locally. Your review is saved.': '已在本机检查，你的检查结果已保存。',
  'Result checked. Undo remains available on the card.': '结果已检查，可在卡片上撤销。',
  'Marked complete.': '已标记完成。', 'New work updates applied.': '已应用新的工作更新。', 'List closed': '列表已收起',
  'The local review could not be saved. Try again.': '本机检查结果保存失败，请重试。',
  'Clipboard unavailable': '无法使用剪贴板', 'Clipboard unavailable. Copy the selected handoff text below.': '无法使用剪贴板，请手动复制下方选中的交接文字。',
  'Handoff copied. Nothing was sent.': '交接说明已复制，没有发送任何内容。',
  'Handoff copied. Paste it into the agent or conversation you choose.': '交接说明已复制，可粘贴到你选的 AI 或对话里。',
  // Connection problems
  'Local work could not be loaded.': '无法加载本机的工作。', 'Local source unavailable': '本机数据源不可用',
  'Local updates have stopped arriving. Showing the last received work.': '本机更新已停止到达，当前显示最后收到的内容。',
  'Connected, but saved work cannot be read right now. Showing the last received work.': '已连接，但暂时读不到已保存的工作，当前显示最后收到的内容。',
  'Connected, but the saved work has not been refreshed. Showing the last received work.': '已连接，但已保存的工作还没刷新，当前显示最后收到的内容。',
  'Connection interrupted. Showing the last received work while the local feed reconnects.': '连接中断，重连期间显示最后收到的内容。',
  'Reconnecting to this computer. No fresh update has arrived; showing the last received work.': '正在重连本机，暂无新更新，显示最后收到的内容。',
  'Keep this page open to reconnect, or open the memory viewer to inspect the worker.': '保持本页打开即可自动重连，也可以打开记忆查看器检查后台服务。',
  'Source and browser clocks differ; freshness uses received heartbeats. ': '数据源和浏览器时钟不一致，新鲜度按收到的心跳计算。',
  // TeamBrain
  'Optional shared workspace': '可选：团队共享空间',
  'See the work your team chose to share, and the next step you can help with.': '查看团队成员愿意分享的工作，以及你可以帮忙的下一步。',
  'Your personal work stays separate.': '你个人的工作是分开的，不会被共享。',
  'Check your connection to see shared work.': '检查连接后才能看到共享的工作。',
  'No shared update received in this visit.': '本次访问还没收到共享更新。',
  'Get connected': '开始连接', 'Choose how to join your team.': '选择加入团队的方式。',
  'TeamBrain adds a shared view beside My Work. Each member chooses what to share; opening this page does not upload your local work.': 'TeamBrain 在“我的工作”旁边增加一个共享视图。每个成员自己决定分享什么；打开本页不会上传你本机的工作。',
  'Start a team': '创建团队',
  'Set up a team account in CMEM Cloud, check the available plan, and invite the people you work with.': '在 CMEM Cloud 创建团队账号，查看可用套餐，再邀请一起工作的人。',
  'Set up a team ↗': '创建团队 ↗',
  'Plan eligibility and current pricing are shown during setup. This page does not start a subscription.': '套餐资格和当前价格会在创建时显示。本页不会开通任何订阅。',
  'Use an existing invitation': '使用已有邀请',
  'Ask a team owner for an invite link, then run this command in a terminal on this computer:': '向团队所有者要一个邀请链接，然后在这台电脑的终端里运行：',
  'Sign in and approve this device. An installation already connected to another account must resolve that account choice first.': '登录并批准这台设备。已连接到其他账号的安装需要先处理账号选择。',
  'Refresh connection': '刷新连接', 'What connects here': '这里连接什么',
  'This panel reads shared lists, tasks and findings through your approved CMEM connection. Claude.ai and ChatGPT setup remains separate. TeamBrain does not assign work, send replies, or sync your private review notes.': '本面板通过你已批准的 CMEM 连接读取共享的清单、任务和发现。Claude.ai 和 ChatGPT 的连接是另外设置的。TeamBrain 不会派发任务、发送回复，也不会同步你私人的检查笔记。',
  'Already a member? Open your team account ↗': '已经是成员？打开你的团队账号 ↗',
  'Shared work': '共享的工作', 'Team': '团队', 'Team settings ↗': '团队设置 ↗', 'Refresh': '刷新',
  'Search shared work, people and projects': '搜索共享的工作、成员和项目', 'Search shared work, people or projects': '搜索共享的工作、成员或项目',
  'Filter shared work by project': '按项目筛选共享的工作',
  'Recorded team activity, not a presence signal. Continue with your teammate or in the source conversation. Private review notes stay on this computer.': '这是已记录的团队动态，不代表对方在线。请联系队友或回到原对话继续。你私人的检查笔记只留在这台电脑上。',
  'Checking your TeamBrain connection…': '正在检查你的 TeamBrain 连接…',
  'Shared updates connected': '共享更新已连接', 'Shared updates stale. Checking for a fresh update…': '共享更新已过时，正在检查新的更新…',
  'Shared work could not be loaded.': '无法加载共享的工作。',
  'Team member': '团队成员', 'Team membership': '团队成员资格',
  'TeamBrain is optional. My Work remains local and free.': 'TeamBrain 是可选的，“我的工作”始终在本机、免费。',
  'No active TeamBrain membership was found for this install. Check your account or invitation in TeamBrain.': '这个安装没有找到有效的 TeamBrain 成员资格，请在 TeamBrain 里检查账号或邀请。',
  'You are viewing shared work. Sharing from this computer is off.': '你正在查看共享的工作，这台电脑的共享是关闭的。',
  'The shared board response could not be read.': '无法读取共享看板的返回内容。',
  'The shared work response could not be read.': '无法读取共享工作的返回内容。',
  'The team membership response could not be read.': '无法读取团队成员资格的返回内容。',
  'The team connection timed out. Refresh to try again.': '团队连接超时，请刷新重试。',
};

const ago = { m: '分钟', h: '小时', d: '天', w: '周' };
const PATTERNS = [
  [/^(\d+) work records? need(?:s)? a linked human request$/, (_, n) => `${n} 条工作记录没有对应到你下的任务`],
  [/^(\d+)([mhdw]) ago$/, (_, n, u) => `${n} ${ago[u]}前`],
  [/^Last received (.+)$/, (_, t) => `最后收到 ${t}`],
  [/^Last successful update (.+)$/, (_, t) => `最后一次成功更新 ${t}`],
  [/^Last successful local check: (.+)\. ?$/, (_, t) => `最后一次本机检查成功：${t == 'not yet confirmed' ? '尚未确认' : t}。`],
  [/^Last connection issue at (.+?): (.+)$/, (_, t, m) => `最后一次连接问题（${t}）：${m}`],
  [/^(.+?) · (\d+) contributors$/, (_, a, n) => `${a} · ${n} 位执行者`],
  [/^(\d+) contributors$/, (_, n) => `${n} 位执行者`],
  [/^Open request: (.+)$/, (_, t) => `打开任务：${t}`],
  [/^Next step: (.+)$/, (_, t) => `下一步：${t}`],
  [/^Project: (.+)$/, (_, t) => `项目：${t}`],
  [/^Request: (.+)$/, (_, t) => `任务：${t}`],
  [/^Recorded state: (.+)$/, (_, t) => `记录状态：${EXACT[t] || t}`],
  [/^Your sharing setting is on for (.+)\.$/, (_, t) => `你的共享设置已对 ${t} 开启。`],
];

function translate(value) {
  const core = value.trim();
  if (!core) return value;
  let out = EXACT[core];
  if (out === undefined) {
    for (const [pattern, make] of PATTERNS) {
      const match = core.match(pattern);
      if (match) { out = make(...match); break; }
    }
  }
  if (out === undefined) return value;
  const lead = value.slice(0, value.indexOf(core));
  return lead + out + value.slice(lead.length + core.length);
}

const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

function walk(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement && SKIP.has(node.parentElement.tagName)) return;
    const next = translate(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName)) return;
  for (const name of ATTRIBUTES) {
    const current = node.getAttribute(name);
    if (current) {
      const next = translate(current);
      if (next !== current) node.setAttribute(name, next);
    }
  }
  for (const child of node.childNodes) walk(child);
}

function run() {
  document.documentElement.lang = 'zh-CN';
  document.title = translate(document.title);
  walk(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') walk(record.target);
      else if (record.type === 'attributes') walk(record.target);
      else record.addedNodes.forEach(walk);
    }
    document.title = translate(document.title);
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ATTRIBUTES,
  });
}

if (document.body) run();
else document.addEventListener('DOMContentLoaded', run);
