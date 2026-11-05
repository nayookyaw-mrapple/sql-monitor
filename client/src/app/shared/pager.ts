import { Component, computed, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'app-pager',
  imports: [DecimalPipe],
  template: `
    <div class="pager">
      <div class="pager-info">
        @if (total() > 0) {
          {{ first() | number }}–{{ last() | number }} of {{ estimate() ? '~' : '' }}{{ total() | number }}
        } @else {
          No rows
        }
      </div>
      <div class="pager-size">
        <label>
          Rows
          <select [value]="pageSize()" (change)="pageSizeChange.emit(+$any($event.target).value)">
            @for (s of sizes(); track s) {
              <option [value]="s" [selected]="s === pageSize()">{{ s }}</option>
            }
          </select>
        </label>
      </div>
      <div class="pager-nav">
        <button type="button" (click)="go(1)" [disabled]="page() <= 1" title="First page">«</button>
        <button type="button" (click)="go(page() - 1)" [disabled]="page() <= 1" title="Previous page">‹</button>
        @for (p of pages(); track $index) {
          @if (p === 0) {
            <span class="gap">…</span>
          } @else {
            <button type="button" [class.active]="p === page()" (click)="go(p)">{{ p | number }}</button>
          }
        }
        <button type="button" (click)="go(page() + 1)" [disabled]="page() >= totalPages()" title="Next page">›</button>
        <button type="button" (click)="go(totalPages())" [disabled]="page() >= totalPages()" title="Last page">»</button>
        <span class="jump">
          Go to
          <input type="number" min="1" [max]="totalPages()" [value]="page()" (keydown.enter)="jump($event)" (blur)="jump($event)" />
        </span>
      </div>
    </div>
  `,
})
export class Pager {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly estimate = input(false);
  readonly sizes = input<number[]>([10, 25, 50, 100, 200, 500]);
  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  readonly first = computed(() => (this.page() - 1) * this.pageSize() + 1);
  readonly last = computed(() => Math.min(this.total(), this.page() * this.pageSize()));

  /** Page numbers to show, 0 = gap. */
  readonly pages = computed(() => {
    const n = this.totalPages();
    const cur = this.page();
    const set = new Set<number>([1, n, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
    const list = [...set].filter((p) => p >= 1 && p <= n).sort((a, b) => a - b);
    const out: number[] = [];
    list.forEach((p, i) => {
      if (i > 0 && p - list[i - 1] > 1) out.push(0);
      out.push(p);
    });
    return out;
  });

  go(p: number): void {
    const target = Math.min(Math.max(1, p), this.totalPages());
    if (target !== this.page()) this.pageChange.emit(target);
  }

  jump(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = Number.parseInt(el.value, 10);
    if (Number.isFinite(v)) this.go(v);
    else el.value = String(this.page());
  }
}
