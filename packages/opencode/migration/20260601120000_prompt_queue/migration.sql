CREATE TABLE `prompt_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_queue_session_position_idx` ON `prompt_queue` (`session_id`,`position`);
