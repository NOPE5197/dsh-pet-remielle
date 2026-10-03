/**
 * Remielle-flavored status copy — a brisk, slightly smug hunter-goddess tone.
 */

const COPY = Object.freeze({
  idle: [
    'Idling~ ping me if a task shows up',
    'No tasks right now, just a quick nap',
    'Remielle is idling~',
  ],
  preparing: [
    'New task in~ let me sort it out first',
    'Let me see what this one needs~',
    'Listing out the task list now',
  ],
  thinking: [
    'Thinking hard about the next step',
    'Let me find the very best answer',
    'Putting it together, one moment~',
  ],
  streaming: [
    'Writing the answer out now~',
    'The words are coming out~',
    'This sentence is nearly done~',
  ],
  searching: [
    'Digging up the relevant bits for you',
    'Searching the project right now',
    'Taking a look at the related files~',
  ],
  editing: [
    'Editing this part right now',
    'Writing the changes in~',
    'Tuning the implementation properly',
  ],
  testing: [
    'Checking the results now~',
    'Running the tests to be sure',
    'Verifying nothing broke~',
  ],
  commanding: [
    'Running the command now~',
    'Getting the project running~',
    'Watching how that command fares',
  ],
  working: [
    'Still working on the task~',
    'This step is underway~',
    'Remielle is still working hard~',
  ],
  result: [
    'Sorting out that result~',
    'That step is done, moving on~',
    'Figuring out the next step now',
  ],
  waiting: [
    'Need you to confirm something~',
    'This one waits for your eyes',
    'Your call this time~',
  ],
  success: [
    'That task is done~',
    'This round went smoothly~',
    'Job finished, not bad~',
  ],
  toolError: [
    'That step did not go through',
    'The last operation hit a snag',
    'That one got stuck — I am watching',
  ],
  error: [
    'This task seems to be in trouble',
    'We need to come back and look here',
    'That one did not finish cleanly',
  ],
  stopped: [
    'The task has stopped~',
    'Parking this task here for now',
  ],
  limit: [
    'That is a lot — hit the limit~',
    'This output hit the cap~',
  ],
})

function seedNumber(seed) {
  const number = Number(seed)
  if (Number.isFinite(number)) return Math.abs(Math.trunc(number))
  return [...String(seed ?? '')].reduce((total, character) => total + character.codePointAt(0), 0)
}

export function statusCopy(group, seed = 0) {
  const variants = COPY[group] ?? COPY.working
  return variants[seedNumber(seed) % variants.length]
}

export function activityCopy(activity, seed = 0) {
  return statusCopy({
    searching: 'searching',
    editing: 'editing',
    testing: 'testing',
    commanding: 'commanding',
  }[activity] ?? 'working', seed)
}

export function activityStage(activity) {
  return {
    searching: 'Searching',
    editing: 'Implementing',
    testing: 'Verifying',
    commanding: 'Executing',
  }[activity] ?? 'Handling'
}

export function taskCopy(task) {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value) return statusCopy('working')
  // Session/task titles may arrive in Chinese or English, so both vocabularies are
  // matched here: Chinese is kept because the incoming data may be Chinese, and the
  // English verbs are its equivalent for the same two phrasing shapes.
  if (/^(正在|继续|working on|continue|continuing|resuming)/iu.test(value)) {
    return `${value}~`
  }
  if (/^(准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现|preparing|prepare|checking|check|verifying|verify|updating|update|fixing|fix|testing|test|building|build|organizing|sorting|analyzing|analyze|searching|search|looking up|reading|read|implementing|implement|refactoring|refactor|rewriting|rewrite)/iu.test(value)) {
    return `${value}…~`
  }
  return `Working on "${value}"~`
}

export { COPY as statusCopyLibrary }
