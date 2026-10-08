# Original requirements engineering exercise

Original teaching scenario: a booking tool must offer cancellation, react to a cancellation request, and state what happens when a booking is already closed. A separate quality constraint specifies a response-time limit under agreed test conditions.

Original teaching scenario: two rules govern the same booking, user, action, time, and conditions. If one requires allowing the action and the other forbids it, both cannot be satisfied. If their conditions differ, check the overlap before claiming a conflict.

Original teaching scenario: the booking query must finish within one second under an explicitly agreed workload. This is a quality constraint. It is not a guarantee about every device, network, or workload.
