/**
 * 去抖与节流。
 *
 * 自动保存要的是「停止输入后存一次」，用去抖；但去抖有个必须处理的场合 ——
 * 用户切后台、关页面、失焦时不能等那段时间，必须立刻把待存的执行掉，
 * 所以这里返回的函数带 `flush` / `cancel`。
 */

type Debounced<T extends unknown[]> = ((...args: T) => void) & {
  /** 立刻执行挂起的调用（若有），并清掉挂起状态。 */
  flush: () => void;
  /** 丢弃挂起的调用，不再执行。 */
  cancel: () => void;
  /** 是否还有挂起未执行的调用。 */
  pending: () => boolean;
};

/**
 * 去抖：连续调用时只执行最后一次，等待 `wait` 毫秒无新调用后执行。
 *
 * `pending()` 供「卸载前还有没落盘的东西」这类判断用；带这个方法后
 * 挂起的参数也需要被记住，所以内部多存一份 `lastArgs`。
 */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, wait: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;

  const run = () => {
    timer = null;
    if (!lastArgs) return;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };

  const debounced = ((...args: T) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, wait);
  }) as Debounced<T>;

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.pending = () => timer !== null;

  return debounced;
}

/**
 * 节流：窗口内最多执行一次，首次立刻执行，窗口内的后续调用合并到窗口结束时补一次。
 *
 * 与 `throttleRAF` 的差别在时间基准：那个按帧、约 16ms，这个按毫秒。流式文本用这个 ——
 * 模型每秒能吐几十个增量，逐个 setState 会让整屏按 token 重渲染，长思考时明显卡。
 */
export function throttle<T extends unknown[]>(fn: (...args: T) => void, wait: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;
  let lastRunAt = 0;

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!lastArgs) return;
    const args = lastArgs;
    lastArgs = null;
    lastRunAt = Date.now();
    fn(...args);
  };

  const throttled = ((...args: T) => {
    lastArgs = args;
    const elapsed = Date.now() - lastRunAt;
    if (elapsed >= wait) {
      run();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, wait - elapsed);
  }) as Debounced<T>;

  throttled.flush = () => run();
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  throttled.pending = () => timer !== null;

  return throttled;
}

/**
 * 每帧最多执行一次：第一次调用立刻执行，帧内的后续调用合并到下一帧。
 *
 * 适合"跟着内容变、但不需要每个中间态都处理"的场合（如滚动联动高亮），
  * 它的代价低于去抖，因为它不会把第一次执行也推迟。
  */
export function throttleRAF<T extends unknown[]>(fn: (...args: T) => void): Debounced<T> {
  let frame: number | null = null;
  let lastArgs: T | null = null;

  const run = () => {
    frame = null;
    if (!lastArgs) return;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };

  const throttled = ((...args: T) => {
    lastArgs = args;
    if (frame === null) {
      frame = requestAnimationFrame(run);
    }
  }) as Debounced<T>;

  throttled.flush = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    run();
  };
  throttled.cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastArgs = null;
  };
  throttled.pending = () => frame !== null;

  return throttled;
}

/**
 * 按帧提交，且两次提交之间不短于 `minGap` 毫秒。
 *
 * 流式文本用它，两个约束各治一半：只按帧提交时，低端机上每帧都渲染仍然偏密；只按毫秒
 * 节流时，提交时点与绘制帧不对齐，文字会在帧中间落下。合并之后 —— 提交落在帧上，间隔
 * 又不短于 `minGap`。
 *
 * 取值依据：约 20 到 25 次/秒仍被读作「连续书写」，再慢就成一格一格；`minGap` 取
 * 40 到 50 之间都在这条线上，低端机可放宽到 100。
 */
export function throttleFrameGap<T extends unknown[]>(fn: (...args: T) => void, minGap: number): Debounced<T> {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;
  let lastRunAt = 0;

  const run = () => {
    frame = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!lastArgs) return;
    const args = lastArgs;
    lastArgs = null;
    lastRunAt = Date.now();
    fn(...args);
  };

  const schedule = () => {
    if (frame !== null || timer !== null) return;
    const elapsed = Date.now() - lastRunAt;
    if (elapsed >= minGap) {
      frame = requestAnimationFrame(run);
      return;
    }
    // 还没到最小间隔：先等到间隔满，再交给下一帧 —— 提交因此永远落在帧上。
    timer = setTimeout(() => {
      timer = null;
      frame = requestAnimationFrame(run);
    }, minGap - elapsed);
  };

  const throttled = ((...args: T) => {
    lastArgs = args;
    schedule();
  }) as Debounced<T>;

  throttled.flush = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    run();
  };
  throttled.cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    frame = null;
    timer = null;
    lastArgs = null;
  };
  throttled.pending = () => frame !== null || timer !== null;

  return throttled;
}