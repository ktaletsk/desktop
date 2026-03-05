import * as LucideIcons from "lucide-react";
import * as React from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

export interface CollaboratorUser {
  id: string;
  name: string;
  picture?: string;
  icon?: string; // Lucide icon name (e.g., "bot", "cat", "bird")
  color?: string;
}

export interface CollaboratorAvatarsProps {
  users: CollaboratorUser[];
  currentUserId?: string;
  limit?: number;
  className?: string;
  size?: "default" | "sm" | "lg";
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// Convert icon name to PascalCase for Lucide icon lookup
function getLucideIcon(
  iconName: string,
): React.ComponentType<{ className?: string }> | null {
  // Convert kebab-case or lowercase to PascalCase (e.g., "bot" -> "Bot", "arrow-right" -> "ArrowRight")
  const pascalCase = iconName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");

  const IconComponent = (LucideIcons as Record<string, unknown>)[pascalCase];
  if (typeof IconComponent === "function") {
    return IconComponent as React.ComponentType<{ className?: string }>;
  }
  return null;
}

export function CollaboratorAvatars({
  users,
  currentUserId,
  limit = 3,
  className,
  size = "sm",
}: CollaboratorAvatarsProps) {
  // Filter out current user from display
  const displayUsers = React.useMemo(() => {
    return currentUserId
      ? users.filter((user) => user.id !== currentUserId)
      : users;
  }, [users, currentUserId]);

  if (displayUsers.length === 0) {
    return null;
  }

  const visibleUsers = displayUsers.slice(0, limit);
  const overflowCount = displayUsers.length - limit;
  const overflowUsers = displayUsers.slice(limit);

  return (
    <AvatarGroup data-slot="collaborator-avatars" className={className}>
      {visibleUsers.map((user) => (
        <HoverCard key={user.id} openDelay={200} closeDelay={100}>
          <HoverCardTrigger asChild>
            <Avatar
              size={size}
              className="cursor-pointer transition-transform hover:scale-110 hover:z-10"
              style={
                user.color
                  ? { boxShadow: `0 0 0 2px ${user.color}` }
                  : undefined
              }
            >
              {user.picture ? (
                <AvatarImage src={user.picture} alt={user.name} />
              ) : null}
              <AvatarFallback
                style={
                  user.color
                    ? { backgroundColor: user.color, color: "white" }
                    : undefined
                }
              >
                {(() => {
                  const Icon = user.icon ? getLucideIcon(user.icon) : null;
                  return Icon ? (
                    <Icon className="h-3 w-3" />
                  ) : (
                    getInitials(user.name)
                  );
                })()}
              </AvatarFallback>
            </Avatar>
          </HoverCardTrigger>
          <HoverCardContent className="w-auto min-w-[120px] p-3">
            <div className="flex items-center gap-2">
              <Avatar size="default">
                {user.picture ? (
                  <AvatarImage src={user.picture} alt={user.name} />
                ) : null}
                <AvatarFallback
                  style={
                    user.color
                      ? { backgroundColor: user.color, color: "white" }
                      : undefined
                  }
                >
                  {(() => {
                    const Icon = user.icon ? getLucideIcon(user.icon) : null;
                    return Icon ? (
                      <Icon className="h-4 w-4" />
                    ) : (
                      getInitials(user.name)
                    );
                  })()}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">{user.name}</span>
            </div>
          </HoverCardContent>
        </HoverCard>
      ))}
      {overflowCount > 0 && (
        <HoverCard openDelay={200} closeDelay={100}>
          <HoverCardTrigger asChild>
            <AvatarGroupCount className="cursor-pointer transition-transform hover:scale-110 hover:z-10">
              +{overflowCount}
            </AvatarGroupCount>
          </HoverCardTrigger>
          <HoverCardContent className="w-auto min-w-[150px] p-3">
            <div className="space-y-2">
              {overflowUsers.map((user) => (
                <div key={user.id} className="flex items-center gap-2">
                  <Avatar size="sm">
                    {user.picture ? (
                      <AvatarImage src={user.picture} alt={user.name} />
                    ) : null}
                    <AvatarFallback
                      style={
                        user.color
                          ? { backgroundColor: user.color, color: "white" }
                          : undefined
                      }
                    >
                      {(() => {
                        const Icon = user.icon
                          ? getLucideIcon(user.icon)
                          : null;
                        return Icon ? (
                          <Icon className="h-3 w-3" />
                        ) : (
                          getInitials(user.name)
                        );
                      })()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm">{user.name}</span>
                </div>
              ))}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </AvatarGroup>
  );
}
