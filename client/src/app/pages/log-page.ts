import { ChangeDetectionStrategy, Component } from '@angular/core';

import { EventLog } from '../panels/event-log';

/**
 * The event log with the whole viewport to itself. The store keeps collecting
 * whether or not this page is on screen, so arriving here shows everything
 * that happened while the console page had it.
 */
@Component({
  selector: 'wt-log-page',
  imports: [EventLog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<wt-event-log />`,
  styles: `
    :host {
      display: block;
    }

    wt-event-log {
      --log-height: max(340px, calc(100vh - 420px));
    }
  `,
})
export class LogPage {}
