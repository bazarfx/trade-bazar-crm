# Stop the test environment. Stopped = storage only (~$4/month).
# Note: AWS restarts a stopped RDS instance by itself after 7 days;
# the 23:00 IST nightly schedule stops it again.
$aws      = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$r        = 'ap-south-1'
$instance = 'i-0f31e28ef78199ee1'

& $aws ec2 stop-instances --region $r --instance-ids $instance --query 'StoppingInstances[0].CurrentState.Name' --output text
$db = & $aws rds describe-db-instances --region $r --db-instance-identifier crm-test-db --query 'DBInstances[0].DBInstanceStatus' --output text
if ($db -eq 'available') { & $aws rds stop-db-instance --region $r --db-instance-identifier crm-test-db --query DBInstance.DBInstanceStatus --output text }
else { "database: $db (not stopped)" }
