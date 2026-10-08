/** Stable public API failure classification; transport chooses how to encode it. */
export class AccountFailure extends Error {
  status:number;
  code:string;
  constructor(status:number,code:string){super(code);this.status=status;this.code=code;}
}
