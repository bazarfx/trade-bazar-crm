# Start the test environment and print today's URL.
# The public IP — and so the sslip.io address — changes on every start.
$aws      = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$r        = 'ap-south-1'
$instance = 'i-0f31e28ef78199ee1'

$db = & $aws rds describe-db-instances --region $r --db-instance-identifier crm-test-db --query 'DBInstances[0].DBInstanceStatus' --output text
if ($db -eq 'stopped') { & $aws rds start-db-instance --region $r --db-instance-identifier crm-test-db --query DBInstance.DBInstanceStatus --output text | Out-Null; 'database: starting (5-10 min)' }
else { "database: $db" }

& $aws ec2 start-instances --region $r --instance-ids $instance | Out-Null
& $aws ec2 wait instance-running --region $r --instance-ids $instance
$ip = & $aws ec2 describe-instances --region $r --instance-ids $instance --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
"server:   running"
""
"App URL:  https://$($ip -replace '\.', '-').sslip.io"
"(the certificate and the database can take a few minutes; the app retries until both are up)"
